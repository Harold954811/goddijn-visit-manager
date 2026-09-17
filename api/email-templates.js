// Lists all email templates from Directus. Used by the frontend to show
// a template selector in the visit form. See Phase 4 of the 2N integration spec.

import { verifyCaller, isAuthorizedCreator } from "../lib/auth.js";

const DIRECTUS = "https://cms.goddijn.net";

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
    const dRes = await fetch(
      `${DIRECTUS}/items/gd_email_templates?limit=-1&sort=sort&fields=id,name,template_type,subject,is_default`,
      { headers: { Authorization: `Bearer ${process.env.DIRECTUS_VISIT_MANAGER_TOKEN}` } }
    );
    if (!dRes.ok) {
      const body = await dRes.text();
      throw new Error(`Directus list failed (${dRes.status}): ${body.slice(0, 300)}`);
    }
    const { data } = await dRes.json();
    res.status(200).json({ templates: data || [] });
  } catch (err) {
    console.error("email-templates endpoint failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
