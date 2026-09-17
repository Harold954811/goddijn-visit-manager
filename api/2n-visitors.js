// Lists all visitors from the 2N Access Commander API. Used by Phase 2
// (existing-visitor email search) and Phase 5 (credentials dashboard).
// Returns the raw visitor objects, normalized to a consistent shape.

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
    const acRes = await fetch(`${process.env.AC_API_URL}/api/v3/Visitors`, {
      headers: { Authorization: `Bearer ${process.env.AC_API_TOKEN}` },
    });
    if (!acRes.ok) {
      const body = await acRes.text();
      throw new Error(`2N visitors fetch failed (${acRes.status}): ${body.slice(0, 300)}`);
    }
    const data = await acRes.json();

    // Normalize: 2N may return an array directly or wrapped in various shapes.
    // Try all known wrappers; fall back to empty array.
    let raw;
    if (Array.isArray(data)) {
      raw = data;
    } else if (Array.isArray(data.data)) {
      raw = data.data;
    } else if (Array.isArray(data.Result)) {
      raw = data.Result;
    } else if (Array.isArray(data.Visitors)) {
      raw = data.Visitors;
    } else if (Array.isArray(data.visitors)) {
      raw = data.visitors;
    } else if (data && typeof data === "object" && data.id) {
      // Single visitor object returned directly
      raw = [data];
    } else {
      // Unknown shape — log it so we can fix the normalization
      console.error("2N visitors response shape unknown:", JSON.stringify(data).slice(0, 500));
      raw = [];
    }

    // Map to a consistent shape with camelCase keys for the frontend.
    const visitors = raw.map((v) => ({
      id: v.Id || v.id,
      name: v.Name || v.name,
      email: v.Email || v.email || null,
      visitFrom: v.VisitFrom || v.visitFrom || null,
      visitTo: v.VisitTo || v.visitTo || null,
      pin: v.Credentials?.Pin || v.credentials?.pin || null,
      groups: (v.Groups || v.groups || []).map((g) => ({
        id: g.Id || g.id,
        name: g.Name || g.name,
      })),
    }));

    res.status(200).json({ visitors });
  } catch (err) {
    console.error("2n-visitors endpoint failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
