// Mirrors the house hierarchy in Goddijn-net-launchpad's lib/houses.js
// (property -> domain -> house, using each house's Directus `matchHouse`
// value as the identifier stored on a gd_visits row). Kept as a small
// static copy here rather than a cross-repo import -- these are two
// separate deployments. Update both places together if a house is added,
// renamed, or removed.
//
// Maison Principale (Castellas) and the Loveland "Maison Principale" house
// are deliberately absent from this list. The family's own private
// residence at Loveland must never be offered here at all -- see
// memory://facts/loveland-maison-principale-is-private. (Loveland's
// HIERARCHY entry in the guest-guide repo never listed it as a house for
// the same reason; Castellas's "Maison Principale" is a real guest house
// there and stays out of this app only because visit-based access has not
// been extended to Castellas yet -- add it here once it is.)

export const PROPERTIES = [
  {
    id: "mougins",
    name: "Mougins",
    domains: [
      {
        id: "loveland",
        name: "Loveland",
        houses: [
          { matchHouse: "Gardien", name: "Maison Gardien" },
          { matchHouse: "Pavillon", name: "Le Pavillon" },
          { matchHouse: "Maison Invités (Loveland)", name: "Maison Invités" },
          { matchHouse: "Parfumeur", name: "Parfumeur" },
        ],
      },
      {
        id: "castellas",
        name: "Castellas",
        houses: [{ matchHouse: "Maison Invités (Castellas)", name: "Maison Invités" }],
      },
    ],
  },
  {
    id: "courchevel",
    name: "Courchevel",
    domains: [
      {
        id: "les-petits-loups",
        name: "Les Petits Loups",
        houses: [{ matchHouse: "Les Petits Loups", name: "Les Petits Loups" }],
      },
    ],
  },
  {
    id: "amsterdam",
    name: "Amsterdam",
    domains: [{ id: "amsterdam", name: "Amsterdam", houses: [{ matchHouse: "Amsterdam", name: "Amsterdam" }] }],
  },
  {
    id: "rome",
    name: "Rome",
    domains: [{ id: "rome", name: "Rome", houses: [{ matchHouse: "Rome", name: "Rome" }] }],
  },
];

/** Flat [{ groupLabel, matchHouse, name }] for a single <select>. */
export function houseOptions() {
  const out = [];
  for (const property of PROPERTIES) {
    for (const domain of property.domains) {
      const groupLabel =
        property.domains.length > 1 ? `${property.name} — ${domain.name}` : property.name;
      for (const house of domain.houses) {
        out.push({ groupLabel, matchHouse: house.matchHouse, name: house.name });
      }
    }
  }
  return out;
}
