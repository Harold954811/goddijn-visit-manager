// 2N Access Commander REST API integration — creates and deletes temporary
// visitors with PIN door codes, scoped to the right zone group for the
// house a guest is staying at.
//
// The 2N API (v3) is at https://192.168.60.40/api/v3/ (also reachable via
// https://commander.goddijn.net/api/v3/). Auth is a Bearer token created
// in AC's web UI (Settings > API access tokens). See
// memory://projects/unified-guest-access-2n-cloudflare for the full
// backstory — the root-password blocker was cleared 2026-09-16.
//
// Env vars required (set in the Vercel project):
//   AC_API_URL   -- e.g. https://192.168.60.40
//   AC_API_TOKEN -- the read+write token from AC's web UI

// Map each Visit Manager house (by its Directus matchHouse value) to the
// 2N visitor group that controls the right doors. These group IDs come
// from the company's PredefinedVisitorGroups in AC. Houses without 2N
// devices (Rome) have no entry — provisioning is skipped for them.
//
// Group IDs (verified 2026-09-16 via GET /api/v3/Companies):
//   Amsterdam:        5b7e0cc0-228c-4670-8cd0-a19d3fc67357
//   Castellas:        34af53fe-e5cb-4693-8e67-c8796c2c71db
//   Embertrand All:   7cc696bc-6fa2-41d4-975c-d74e369f8e02
//   Petits Loups:     f7f2a827-b171-44b1-9456-5bcc9a95a1fa
const HOUSE_TO_2N_GROUP = {
  // Amsterdam
  Amsterdam: { id: "5b7e0cc0-228c-4670-8cd0-a19d3fc67357", name: "Amsterdam" },
  // Mougins — Loveland (all Loveland houses share the Embertrand All group,
  // which covers every door on the Loveland/Embertrand property)
  Gardien: { id: "7cc696bc-6fa2-41d4-975c-d74e369f8e02", name: "Embertrand All " },
  Pavillon: { id: "7cc696bc-6fa2-41d4-975c-d74e369f8e02", name: "Embertrand All " },
  "Maison Invités (Loveland)": { id: "7cc696bc-6fa2-41d4-975c-d74e369f8e02", name: "Embertrand All " },
  Parfumeur: { id: "7cc696bc-6fa2-41d4-975c-d74e369f8e02", name: "Embertrand All " },
  // Mougins — Castellas
  "Maison Principale (Castellas)": { id: "34af53fe-e5cb-4693-8e67-c8796c2c71db", name: "Castellas" },
  "Maison Invités (Castellas)": { id: "34af53fe-e5cb-4693-8e67-c8796c2c71db", name: "Castellas" },
  // Courchevel
  "Les Petits Loups": { id: "f7f2a827-b171-44b1-9456-5bcc9a95a1fa", name: "Petits Loups" },
  // Rome — no 2N devices, no entry (provisioning skipped)
};

// The company ID in Access Commander (verified 2026-09-16).
const AC_COMPANY_ID = 2;
const AC_COMPANY_NAME = "Goddijn & Vigreux";

function acHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.AC_API_TOKEN}`,
  };
}

function acUrl(path) {
  return `${process.env.AC_API_URL}${path}`;
}

// Generate a random 6-digit PIN. 2N requires 2–15 digits; 6 is a good
// balance between security and ease of use for a guest.
function generatePin() {
  // Use crypto.randomUUID for entropy if available, otherwise Math.random
  let bytes;
  if (globalThis.crypto?.getRandomValues) {
    bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
  } else {
    bytes = Array.from({ length: 4 }, () => Math.floor(Math.random() * 256));
  }
  const num = (bytes[0] * 256 * 256 * 256 + bytes[1] * 256 * 256 + bytes[2] * 256 + bytes[3]) % 1000000;
  return String(num).padStart(6, "0");
}

// Returns the 2N visitor group for a given house, or null if the house
// has no 2N devices (e.g. Rome).
export function getGroupForHouse(house) {
  return HOUSE_TO_2N_GROUP[house] || null;
}

// Creates a 2N visitor with a PIN door code, scoped to the right group
// for the house. Returns { visitorId, pin } on success, or null if the
// house has no 2N devices (no error — just nothing to provision).
//
// If a pin is provided, uses it; otherwise generates a random one.
export async function createVisitor({ guestName, guestEmail, house, startDate, endDate, pin }) {
  const group = getGroupForHouse(house);
  if (!group) {
    // No 2N devices at this house — skip provisioning silently
    return null;
  }

  const visitorPin = pin || generatePin();

  const body = {
    Name: guestName || "Guest",
    Company: { Id: AC_COMPANY_ID, Name: AC_COMPANY_NAME },
    Email: guestEmail || null,
    VisitFrom: `${startDate}T00:00:00.000Z`,
    VisitTo: `${endDate}T23:59:59.000Z`,
    Groups: [{ Id: group.id, Name: group.name }],
    Credentials: { Pin: visitorPin },
  };

  const res = await fetch(acUrl("/api/v3/Visitors"), {
    method: "POST",
    headers: acHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`2N create visitor failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    visitorId: data.Id,
    pin: visitorPin,
  };
}

// Deletes a 2N visitor by ID, revoking their PIN immediately.
// Called when a visit is revoked in Visit Manager.
export async function deleteVisitor(visitorId) {
  if (!visitorId) return;

  const res = await fetch(acUrl(`/api/v3/Visitors/${encodeURIComponent(visitorId)}`), {
    method: "DELETE",
    headers: acHeaders(),
  });

  if (!res.ok && res.status !== 404) {
    // 404 is fine — visitor may have already been deleted or never created
    const text = await res.text();
    throw new Error(`2N delete visitor failed (${res.status}): ${text.slice(0, 300)}`);
  }
}
