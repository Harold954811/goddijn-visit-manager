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
import { deleteVisitor, revokeVisitorAccess } from "../lib/2n.js";

const DIRECTUS = "https://cms.goddijn.net";

// Fetch the house → 2N group mapping from Directus (same pattern as create-visit).
let housesCache = { map: null, fetchedAt: 0 };
const HOUSES_TTL_MS = 5 * 60 * 1000;

async function fetchHousesMap() {
  const now = Date.now();
  if (housesCache.map && now - housesCache.fetchedAt < HOUSES_TTL_MS) return housesCache.map;
  try {
    const res = await fetch(
      `${DIRECTUS}/items/gd_houses?limit=-1&fields=house,two_n_group_id`,
      { headers: { Authorization: `Bearer ${process.env.DIRECTUS_VISIT_MANAGER_TOKEN}` } }
    );
    if (!res.ok) return housesCache.map || new Map();
    const { data } = await res.json();
    const map = new Map();
    for (const row of data || []) {
      map.set(row.house, { twoNGroupId: row.two_n_group_id || null });
    }
    housesCache = { map, fetchedAt: now };
    return map;
  } catch {
    return housesCache.map || new Map();
  }
}

async function revokeOneVisit(id, token, delete2NVisitor = false) {
  // Read the visit row
  const getRes = await fetch(
    `${DIRECTUS}/items/gd_visits/${encodeURIComponent(id)}?fields=id,guest_name,guest_email,status,ac_visitor_id,website_access,house,door_code`,
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

  // Handle the 2N visitor: delete entirely, or revoke access (delete + recreate
  // with same PIN but a past time window) so the PIN can't open doors but stays
  // on file for quick re-extension. If 2N fails, the visit is still revoked in
  // Directus and Cloudflare, but we surface the error to the user.
  let twoNError = null;
  if (visit.ac_visitor_id) {
    try {
      if (delete2NVisitor) {
        await deleteVisitor(visit.ac_visitor_id);
      } else {
        // Look up the 2N group for this house
        const housesMap = await fetchHousesMap();
        const houseData = housesMap.get(visit.house);
        const twoNGroupId = houseData?.twoNGroupId || null;

        const result = await revokeVisitorAccess(
          visit.ac_visitor_id,
          visit.door_code, // reuse the same PIN
          visit.guest_name,
          visit.guest_email,
          twoNGroupId,
          null // group name not critical for recreate
        );

        // Update the gd_visits row with the new 2N visitor ID
        if (result?.visitorId) {
          await fetch(`${DIRECTUS}/items/gd_visits/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ ac_visitor_id: result.visitorId }),
          });
        }
      }
    } catch (err) {
      console.error("2N visitor handling failed:", err);
      twoNError = err.message;
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

  // Return the 2N error if any, so the caller can surface it to the user
  visit._twoNError = twoNError;
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

  const { id, visitGroupId } = req.body || {};
  const delete2N = req.body.deleteVisitor === true;
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
      res.status(200).json({ ok: true, revoked: 1, twoNError: visit._twoNError || null });
    } else {
      res.status(400).json({ error: "Missing visit id or visit group id" });
      return;
    }
  } catch (err) {
    console.error("revoke-visit failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
