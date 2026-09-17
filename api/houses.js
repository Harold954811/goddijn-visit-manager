// Returns the property → domain → house hierarchy from Directus (gd_houses),
// with each house's 2N group UUID attached. Replaces the static src/houses.js
// as the source of truth for the frontend house picker. See
// memory://projects/goddijn-visit-manager-app and the 2N integration spec.

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
      `${DIRECTUS}/items/gd_houses?limit=-1&sort=sort&fields=id,house,location,domain,two_n_group_id`,
      { headers: { Authorization: `Bearer ${process.env.DIRECTUS_VISIT_MANAGER_TOKEN}` } }
    );
    if (!dRes.ok) {
      const body = await dRes.text();
      throw new Error(`Directus list failed (${dRes.status}): ${body.slice(0, 300)}`);
    }
    const { data: rows } = await dRes.json();

    // Build the property → domain → house tree from the flat rows.
    // Houses with domain=null are single-domain properties (domain label
    // becomes the property name itself, matching the old src/houses.js shape).
    const properties = [];
    const propMap = {}; // location -> { id, name, domains: [], domainMap: {} }

    for (const row of rows) {
      const loc = row.location || "Unknown";
      if (!propMap[loc]) {
        const prop = { id: loc.toLowerCase().replace(/\s+/g, "-"), name: loc, domains: [] };
        propMap[loc] = prop;
        properties.push(prop);
      }
      const prop = propMap[loc];

      const domName = row.domain || loc;
      if (!prop.domainMap) prop.domainMap = {};
      if (!prop.domainMap[domName]) {
        const dom = {
          id: domName.toLowerCase().replace(/\s+/g, "-"),
          name: domName,
          houses: [],
        };
        prop.domainMap[domName] = dom;
        prop.domains.push(dom);
      }
      prop.domainMap[domName].houses.push({
        matchHouse: row.house,
        name: row.house,
        twoNGroupId: row.two_n_group_id || null,
      });
    }

    // Clean up the temporary domainMap before sending
    for (const prop of properties) {
      delete prop.domainMap;
    }

    // Also produce a flat options list for convenience
    const options = [];
    for (const prop of properties) {
      for (const dom of prop.domains) {
        const groupLabel = prop.domains.length > 1 ? `${prop.name} — ${dom.name}` : prop.name;
        for (const house of dom.houses) {
          options.push({ groupLabel, matchHouse: house.matchHouse, name: house.name, twoNGroupId: house.twoNGroupId });
        }
      }
    }

    res.status(200).json({ properties, options });
  } catch (err) {
    console.error("houses endpoint failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
