// 2N Access Commander REST API integration — creates, updates, and deletes
// temporary visitors with PIN door codes, scoped to the right zone group
// for the house a guest is staying at.
//
// The 2N API (v3) is at https://ac.goddijn.net/api/v3/ (via Cloudflare
// Tunnel). Auth is a Bearer token created in AC's web UI. See
// memory://projects/unified-guest-access-2n-cloudflare for the full
// backstory.
//
// Env vars required (set in the Vercel project):
//   AC_API_URL   -- e.g. https://ac.goddijn.net
//   AC_API_TOKEN -- the read+write token from AC's web UI
//
// CHANGED 2026-09-17 (Phase 1 of the 2N integration spec): the hardcoded
// HOUSE_TO_2N_GROUP map has been removed. The group ID now comes from the
// gd_houses Directus collection's two_n_group_id field, passed in by the
// caller. This makes adding a house or reassigning a door group a data
// change, not a code deploy.

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
  let bytes;
  if (globalThis.crypto?.getRandomValues) {
    bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
  } else {
    bytes = Array.from({ length: 4 }, () => Math.floor(Math.random() * 256));
  }
  const num = (bytes[0] * 256 * 256 * 256 + bytes[1] * 256 * 256 + bytes[2] * 256 + bytes[3]) % 1000000;
  return String(num).padStart(6, "0");
}

// Creates a 2N visitor with a PIN door code, scoped to the given group.
// Returns { visitorId, pin } on success, or null if no groupId was
// provided (house has no 2N devices — skip silently).
//
// CHANGED: the caller now passes twoNGroupId and groupName directly,
// instead of the function looking up a hardcoded map by house name.
export async function createVisitor({ guestName, guestEmail, startDate, endDate, pin, twoNGroupId, groupName }) {
  if (!twoNGroupId) {
    return null;
  }

  const visitorPin = pin || generatePin();

  const body = {
    Name: guestName || "Guest",
    Company: { Id: AC_COMPANY_ID, Name: AC_COMPANY_NAME },
    Email: guestEmail || null,
    VisitFrom: `${startDate}T00:00:00.000Z`,
    VisitTo: `${endDate}T23:59:59.000Z`,
    Groups: [{ Id: twoNGroupId, Name: groupName || "" }],
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

// Updates an existing 2N visitor's time window and/or group. Used by the
// "extend visit" flow (Phase 2) — the PIN stays the same, only the dates
// and optionally the door group change.
//
// NOTE: whether 2N supports PUT on /api/v3/Visitors/{id} is unverified.
// If it doesn't work, the caller should fall back to delete + recreate.
// See the spec's "To verify during implementation" section.
export async function updateVisitor({ visitorId, startDate, endDate, twoNGroupId, groupName }) {
  const changes = {
    VisitFrom: `${startDate}T00:00:00.000Z`,
    VisitTo: `${endDate}T23:59:59.000Z`,
  };
  if (twoNGroupId) {
    changes.Groups = [{ Id: twoNGroupId, Name: groupName || "" }];
  }
  return await updateVisitorFields(visitorId, changes);
}

// Shared helper: GETs the current visitor, merges the changed fields into
// the full object, then PUTs it back. The 2N API requires a complete visitor
// object on PUT (Name is required even when only updating dates) — a partial
// body returns 400 with "The Name field is required." (confirmed 2026-09-17).
async function updateVisitorFields(visitorId, changes) {
  const url = acUrl(`/api/v3/Visitors/${encodeURIComponent(visitorId)}`);
  const headers = acHeaders();

  // GET the current visitor to get the full object
  const getRes = await fetch(url, { headers });
  if (!getRes.ok) {
    const text = await getRes.text();
    throw new Error(`2N get visitor (for update) failed (${getRes.status}): ${text.slice(0, 300)}`);
  }
  const current = await getRes.json();

  // Merge: start from the full current object, apply our changes on top
  const fullBody = { ...current, ...changes };
  // Remove read-only fields that 2N may reject on PUT
  delete fullBody.Id;
  delete fullBody.id;

  // PUT the merged full object
  const putRes = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(fullBody),
  });
  if (putRes.ok) return putRes.json();

  const putText = await putRes.text();
  throw new Error(`2N update visitor (PUT full object) failed (${putRes.status}): ${putText.slice(0, 300)}`);
}

// Reads a single 2N visitor by ID. Used to fetch the current PIN when
// extending a visit (so it can be stored on the gd_visits row).
export async function getVisitorById(visitorId) {
  const res = await fetch(acUrl(`/api/v3/Visitors/${encodeURIComponent(visitorId)}`), {
    headers: acHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`2N get visitor failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  // Normalize: 2N may return the object directly or wrapped
  const v = Array.isArray(data) ? data[0] : data.data || data.Result || data;
  return {
    id: v.Id || v.id,
    name: v.Name || v.name,
    email: v.Email || v.email || null,
    visitFrom: v.VisitFrom || v.visitFrom || null,
    visitTo: v.VisitTo || v.visitTo || null,
    pin: v.Credentials?.Pin || v.credentials?.pin || null,
    groups: (v.Groups || v.groups || []).map((g) => ({ id: g.Id || g.id, name: g.Name || g.name })),
  };
}

// Revokes a 2N visitor's access by deleting and recreating with the
// same PIN but a 1-second time window in the past. The 2N PUT endpoint
// is unreliable (400 Name required, then 500 save user setting), so we
// use the confirmed-working POST + DELETE instead.
// Returns { visitorId, pin } for the new visitor, or throws on failure.
export async function revokeVisitorAccess(visitorId, pin, guestName, guestEmail, twoNGroupId, groupName) {
  if (!visitorId) return null;

  // Delete the existing visitor
  try {
    await deleteVisitor(visitorId);
  } catch (err) {
    console.error("2N delete during revoke (non-fatal, will try recreate):", err);
  }

  // Recreate with the same PIN but a time window that has already passed.
  // Use precise ISO timestamps for a 1-second window ending now.
  const now = new Date();
  const from = new Date(now.getTime() - 1000);

  const body = {
    Name: guestName || "Guest",
    Company: { Id: AC_COMPANY_ID, Name: AC_COMPANY_NAME },
    Email: guestEmail || null,
    VisitFrom: from.toISOString(),
    VisitTo: now.toISOString(),
    Groups: twoNGroupId ? [{ Id: twoNGroupId, Name: groupName || "" }] : [],
    Credentials: { Pin: pin },
  };

  const res = await fetch(acUrl("/api/v3/Visitors"), {
    method: "POST",
    headers: acHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`2N recreate during revoke failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return { visitorId: data.Id, pin };
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
    const text = await res.text();
    throw new Error(`2N delete visitor failed (${res.status}): ${text.slice(0, 300)}`);
  }
}
