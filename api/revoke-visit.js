// Revokes visit access. Soft revoke: sets status=Revoked on the gd_visits
// row (no delete — the scoped token has no delete permission by design,
// and a kept row is a better audit trail).
//
// Supports two modes:
//  - { id } — revoke a single visit
//  - { visitGroupId } — revoke all visits sharing that group ID (family visit)
//
// For each revoked visit: sets status=Revoked, deletes the 2N visitor
// (revoking their PIN), removes the guest's email from Cloudflare's guest
// allow-list only if no other active visit with website_access needs it,
// and force-revokes any live Cloudflare session for that email.

import { verifyCaller, isAuthorizedCreator } from "../lib/auth.js";
import { removeFromCloudflareAllowlist, revokeCloudflareSession } from "../lib/cloudflare.js";
import { deleteVisitor, deactivateVisitor } from "../lib/2n.js";

const DIRECTUS = "https://cms.goddijn.net";

async function revokeOneVisit(id, token, delete2NVisitor = false) {
  // Read the visit row
  const getRes = await fetch(
    `${DIRECTUS}/items/gd_visits/${encodeURIComponent(id)}?fields=id,guest_email,status,ac_visitor_id,website_access`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!getRes.ok) {
    const body = await getRes.text();
    throw new Error(`Directus read failed (${getRes.status}): ${body.slice(0, 300)}`);
  }
  const { data: visit } = await getRes.json();
  if (!visit) return null; // not found — skip

  // Already revoked — skip
  if (visit.status === "Revoked") return visit;

  // Set status=Revoked
  const patchRes = await fetch(`${DIRECTUS}/items/gd_visits/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ status: "Revoked" }),
  });
  if (!patchRes.ok) {
    const body = await patchRes.text();
    throw new Error(`Directus revoke failed (${patchRes.status}): ${body.slice(0, 300)}`);
  }

  // Handle the 2N visitor: delete entirely, or deactivate (set VisitTo to now)
  // so the PIN stops working but the visitor record remains for future re-extension.
  // Non-fatal: if 2N fails, the visit is still revoked in Directus and Cloudflare.
  if (visit.ac_visitor_id) {
    try {
      if (delete2NVisitor) {
        await deleteVisitor(visit.ac_visitor_id);
      } else {
        await deactivateVisitor(visit.ac_visitor_id);
      }
    } catch (err) {
      console.error("2N visitor handling failed (non-fatal):", err);
    }
  }

  // Remove from Cloudflare allow-list only if no other active visit
  // with website_access=true exists for this email
  const otherRes = await fetch(
    `${DIRECTUS}/items/gd_visits?fields=id` +
      `&filter[guest_email][_eq]=${encodeURIComponent(visit.guest_email)}` +
      `&filter[status][_nin]=Revoked,Expired&filter[id][_neq]=${encodeURIComponent(id)}&limit=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (otherRes.ok) {
    const otherBody = await otherRes.json();
    if (!otherBody.data || otherBody.data.length === 0) {
      await removeFromCloudflareAllowlist(visit.guest_email);
    }
  }

  // Always revoke the live Cloudflare session (forces fresh login)
  await revokeCloudflareSession(visit.guest_email);

  return visit;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const creator = await verifyCaller(req.headers.authorization);
  if (!creator) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (!(await isAuthorizedCreator(creator.email))) {
    res.status(403).json({ error: "Not authorized to revoke visits" });
    return;
  }

  const { id, visitGroupId, deleteVisitor: delete2N } = req.body || {};
  const token = process.env.DIRECTUS_VISIT_MANAGER_TOKEN;

  try {
    if (visitGroupId) {
      // Group revoke: find all visits in the group and revoke each
      const groupRes = await fetch(
        `${DIRECTUS}/items/gd_visits?fields=id,status` +
          `&filter[visit_group_id][_eq]=${encodeURIComponent(visitGroupId)}&limit=-1`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!groupRes.ok) {
        const body = await groupRes.text();
        throw new Error(`Directus group query failed (${groupRes.status}): ${body.slice(0, 300)}`);
      }
      const { data: groupVisits } = await groupRes.json();
      const toRevoke = (groupVisits || []).filter((v) => v.status !== "Revoked");

      for (const v of toRevoke) {
        await revokeOneVisit(v.id, token, !!delete2N);
      }
      res.status(200).json({ ok: true, revoked: toRevoke.length });
    } else if (id !== undefined && id !== null && id !== "") {
      const visit = await revokeOneVisit(id, token, !!delete2N);
      if (!visit) {
        res.status(404).json({ error: "Visit not found" });
        return;
      }
      res.status(200).json({ ok: true, revoked: 1 });
    } else {
      res.status(400).json({ error: "Missing visit id or visit group id" });
      return;
    }
  } catch (err) {
    console.error("revoke-visit failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
