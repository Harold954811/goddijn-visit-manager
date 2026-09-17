// Diagnostic endpoint: calls the 2N API and returns the raw response
// (status, headers, body) so we can debug why /api/2n-visitors gets no data.
// Auth-gated like all other endpoints. Remove after debugging is complete.

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

  const acUrl = process.env.AC_API_URL;
  const acToken = process.env.AC_API_TOKEN;

  if (!acUrl || !acToken) {
    res.status(500).json({
      error: "Missing env vars",
      acUrl: acUrl ? "set" : "NOT SET",
      acToken: acToken ? "set (len=" + acToken.length + ")" : "NOT SET",
    });
    return;
  }

  try {
    const acRes = await fetch(`${acUrl}/api/v3/Visitors`, {
      headers: { Authorization: `Bearer ${acToken}` },
    });

    const body = await acRes.text();
    const contentType = acRes.headers.get("content-type");

    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = "NOT JSON";
    }

    res.status(200).json({
      status: acRes.status,
      contentType,
      acUrl,
      bodyPreview: body.slice(0, 1000),
      parsed,
      parsedType: parsed === "NOT JSON" ? "string" : typeof parsed,
      isArray: Array.isArray(parsed),
      keys: parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.keys(parsed).slice(0, 20)
        : null,
    });
  } catch (err) {
    res.status(502).json({
      error: err.message,
      acUrl,
      acTokenSet: !!acToken,
    });
  }
}
