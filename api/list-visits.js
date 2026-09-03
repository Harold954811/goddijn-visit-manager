// Lists every gd_visits row (all statuses) for the "who stays where and
// when" overview. Same auth gate as create-visit.js: a valid Supabase
// session AND an @goddijn.net email.

import { verifyCaller, isAuthorizedCreator } from "../lib/auth.js";

const DIRECTUS = "https://cms.goddijn.net";
const FIELDS = "id,guest_name,guest_email,house,visit_type,start_date,end_date,status,notes";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const creator = await verifyCaller(req.headers.authorization);
  if (!creator) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (!isAuthorizedCreator(creator.email)) {
    res.status(403).json({ error: "Not authorized to view visits" });
    return;
  }

  try {
    const dRes = await fetch(
      `${DIRECTUS}/items/gd_visits?fields=${FIELDS}&sort=-start_date&limit=-1`,
      { headers: { Authorization: `Bearer ${process.env.DIRECTUS_VISIT_MANAGER_TOKEN}` } }
    );
    if (!dRes.ok) {
      const body = await dRes.text();
      throw new Error(`Directus list failed (${dRes.status}): ${body.slice(0, 300)}`);
    }
    const body = await dRes.json();
    res.status(200).json({ visits: body.data });
  } catch (err) {
    console.error("list-visits failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
