// Revokes one visit's access. Deliberately a soft revoke, not a delete:
// sets status=Revoked on the gd_visits row (Directus's write-scoped
// visit-manager token has no delete permission by design -- see
// memory://projects/goddijn-visit-manager-app -- and a kept, marked-revoked
// row is a better audit trail than a vanished one anyway).
//
// Also removes the guest's email from the Cloudflare guest allow-list, but
// ONLY if no OTHER active/live visit for that same email still needs it --
// one person can legitimately have more than one stay. Always revokes any
// live Cloudflare Access session for the email regardless, so a revoked
// guest can't keep using an already-authenticated browser tab; this is
// safe even when another visit still legitimately grants them access
// elsewhere, since revoking a session only forces a fresh login, it never
// denies one.

import { verifyCaller, isAuthorizedCreator } from "../lib/auth.js";
import { removeFromCloudflareAllowlist, revokeCloudflareSession } from "../lib/cloudflare.js";

const DIRECTUS = "https://cms.goddijn.net";

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

  const { id } = req.body || {};
  if (id === undefined || id === null || id === "") {
    res.status(400).json({ error: "Missing visit id" });
    return;
  }

  const token = process.env.DIRECTUS_VISIT_MANAGER_TOKEN;

  try {
    const getRes = await fetch(
      `${DIRECTUS}/items/gd_visits/${encodeURIComponent(id)}?fields=id,guest_email,status`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!getRes.ok) {
      const body = await getRes.text();
      throw new Error(`Directus read failed (${getRes.status}): ${body.slice(0, 300)}`);
    }
    const { data: visit } = await getRes.json();
    if (!visit) {
      res.status(404).json({ error: "Visit not found" });
      return;
    }

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
    await revokeCloudflareSession(visit.guest_email);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("revoke-visit failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
