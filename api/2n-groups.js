// Lists all 2N visitor groups (door zones) from the 2N Access Commander API.
// Used by the frontend to display group names and by the house-mapping flow
// in Directus. See the 2N integration spec, Phase 1.

import { verifyCaller, isAuthorizedCreator } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const caller = await verifyCaller(req.headers.authorization);
  if (!caller) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (!(await isAuthorizedCreator(caller.email))) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }

  try {
    const acRes = await fetch(`${process.env.AC_API_URL}/api/v3/PredefinedVisitorGroups`, {
      headers: { Authorization: `Bearer ${process.env.AC_API_TOKEN}` },
    });
    if (!acRes.ok) {
      const body = await acRes.text();
      throw new Error(`2N groups fetch failed (${acRes.status}): ${body.slice(0, 300)}`);
    }
    const data = await acRes.json();

    // The 2N API may return an array directly or wrapped in { data: [...] }.
    // Normalize to a flat array of { id, name }.
    const groups = (Array.isArray(data) ? data : data.data || data.Result || [])
      .map((g) => ({ id: g.Id || g.id, name: g.Name || g.name }))
      .filter((g) => g.id);

    res.status(200).json({ groups });
  } catch (err) {
    console.error("2n-groups endpoint failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
