// Extends an existing 2N visitor's time window (and optionally changes the
// door group) instead of creating a new visitor from scratch. The existing
// PIN stays the same — the guest doesn't need to learn a new code.
//
// Flow: the frontend searches /api/2n-visitors by email, shows the user
// the existing visitor(s), and if they choose "Extend", this endpoint:
// 1. Calls PUT /api/v3/Visitors/{id} on the 2N API with the new dates/group
// 2. Creates a new gd_visits row referencing the same ac_visitor_id
// 3. Reads the existing PIN from the 2N visitor record and stores it
// 4. Adds the email to Cloudflare (if website_access is true)
// 5. Sends an "extended" email via Resend
//
// If PUT doesn't work (unverified 2N API behavior), the caller should fall
// back to create-visit.js (delete + recreate with a new PIN). See the spec's
// "To verify during implementation" section.
//
// Auth: same Supabase session + creator allow-list gate as create-visit.js.

import { verifyCaller, isAuthorizedCreator } from "../lib/auth.js";
import { updateVisitor, getVisitorById } from "../lib/2n.js";
import { addToCloudflareAllowlist } from "../lib/cloudflare.js";

const DIRECTUS = "https://cms.goddijn.net";
const RESEND_FROM_ADDRESS = "stay@goddijn.net";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Fetch the 2N group ID for a house from Directus (same pattern as create-visit).
let housesCache = { map: null, fetchedAt: 0 };
const HOUSES_TTL_MS = 5 * 60 * 1000;

async function fetchHousesMap() {
  const now = Date.now();
  if (housesCache.map && now - housesCache.fetchedAt < HOUSES_TTL_MS) return housesCache.map;
  try {
    const res = await fetch(
      `${DIRECTUS}/items/gd_houses?limit=-1&fields=house,two_n_group_id&sort=sort`,
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
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
    res.status(403).json({ error: "Not authorized" });
    return;
  }

  const { visitorId, guestName, guestEmail, house, startDate, endDate, notes, websiteAccess } = req.body || {};

  // Validate
  if (!visitorId || typeof visitorId !== "string") {
    res.status(400).json({ error: "Missing 2N visitor ID" });
    return;
  }
  if (!guestName || typeof guestName !== "string" || guestName.length > 200) {
    res.status(400).json({ error: "Guest name is required (max 200 characters)" });
    return;
  }
  if (!guestEmail || !EMAIL_RE.test(guestEmail.trim())) {
    res.status(400).json({ error: "Guest email is missing or not a valid email address" });
    return;
  }
  if (!house || typeof house !== "string") {
    res.status(400).json({ error: "House is required" });
    return;
  }
  if (!DATE_RE.test(startDate || "") || !DATE_RE.test(endDate || "")) {
    res.status(400).json({ error: "Arrival and departure dates must be in YYYY-MM-DD form" });
    return;
  }
  if (new Date(endDate) < new Date(startDate)) {
    res.status(400).json({ error: "Departure date is before arrival date" });
    return;
  }
  if (notes && (typeof notes !== "string" || notes.length > 2000)) {
    res.status(400).json({ error: "Notes must be text under 2000 characters" });
    return;
  }

  const normalizedEmail = guestEmail.trim().toLowerCase();
  const giveWebsiteAccess = websiteAccess !== false; // default true

  // Look up the 2N group ID for this house
  const housesMap = await fetchHousesMap();
  const houseData = housesMap.get(house);
  if (!houseData) {
    res.status(400).json({ error: "House is not one of the known houses" });
    return;
  }
  const twoNGroupId = houseData.twoNGroupId || null;

  try {
    // 1. Update the 2N visitor's time window and group
    await updateVisitor({ visitorId, startDate, endDate, twoNGroupId });

    // 2. Read the current visitor to get the existing PIN
    let existingPin = null;
    try {
      const visitor = await getVisitorById(visitorId);
      existingPin = visitor.pin;
    } catch (err) {
      console.error("2N get visitor failed (non-fatal, PIN may be unavailable):", err);
    }

    // 3. Create the gd_visits row referencing the existing 2N visitor
    const visitRes = await fetch(`${DIRECTUS}/items/gd_visits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DIRECTUS_VISIT_MANAGER_TOKEN}`,
      },
      body: JSON.stringify({
        guest_name: guestName,
        guest_email: normalizedEmail,
        visit_type: "Multi-day stay",
        house,
        start_date: `${startDate}T00:00:00.000Z`,
        end_date: `${endDate}T23:59:59.000Z`,
        status: "Active",
        notes: notes || null,
        door_code: existingPin || null,
        ac_visitor_id: visitorId,
      }),
    });
    if (!visitRes.ok) {
      const body = await visitRes.text();
      throw new Error(`Directus create failed (${visitRes.status}): ${body.slice(0, 300)}`);
    }
    const visit = await visitRes.json();

    // 4. Add to Cloudflare if website access is granted
    if (giveWebsiteAccess) {
      await addToCloudflareAllowlist(normalizedEmail);
    }

    // 5. Send the extension email
    const safeCreatorName = escapeHtml(creator.name);
    const safeGuestName = escapeHtml(guestName || "there");
    const safeHouseName = escapeHtml(house);
    const doorCodeHtml = existingPin
      ? `<p>Your door code is <strong>${escapeHtml(existingPin)}</strong> (unchanged).</p>`
      : "";

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `${safeCreatorName} <${RESEND_FROM_ADDRESS}>`,
        reply_to: creator.email,
        to: [normalizedEmail],
        bcc: ["harold@goddijn.net", "corinne@goddijn.net"],
        subject: `Your stay at ${house} has been extended`,
        html: `
          <p>Hi ${safeGuestName},</p>
          <p>${safeCreatorName} has extended your access to <strong>${safeHouseName}</strong>
          through <strong>${endDate}</strong> (from <strong>${startDate}</strong>).</p>
          ${giveWebsiteAccess ? `<p>Sign in at <a href="https://www.goddijn.net">www.goddijn.net</a> with this email address (${escapeHtml(normalizedEmail)}) for arrival details, Wi-Fi, and everything you'll need.</p>` : ""}
          ${doorCodeHtml}
          <p>See you soon,<br/>${safeCreatorName}</p>
        `,
      }),
    });

    res.status(200).json({
      ok: true,
      visitId: visit?.data?.id ?? null,
      visitorId,
      pin: existingPin,
      extended: true,
    });
  } catch (err) {
    console.error("extend-visit failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
