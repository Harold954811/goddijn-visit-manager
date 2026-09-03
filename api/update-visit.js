// Edits an existing gd_visits row: guest name/email, house, dates, notes,
// status. Same validation rules as create-visit.js, applied only to the
// fields actually present in the request body (a partial patch).
//
// If guestEmail changes, the NEW email is added to the Cloudflare guest
// allow-list so they can actually sign in -- the OLD email is deliberately
// left in place (it may still be needed by another visit); use "Revoke"
// on the old visit separately if the old email should lose access too.

import { verifyCaller, isAuthorizedCreator } from "../lib/auth.js";
import { addToCloudflareAllowlist } from "../lib/cloudflare.js";
import { houseOptions } from "../src/houses.js";

const DIRECTUS = "https://cms.goddijn.net";
const VALID_HOUSES = new Set(houseOptions().map((h) => h.matchHouse));
const VALID_STATUSES = new Set(["Draft", "Sent", "Active", "Expired", "Revoked"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  if (req.method !== "PATCH") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const creator = await verifyCaller(req.headers.authorization);
  if (!creator) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (!isAuthorizedCreator(creator.email)) {
    res.status(403).json({ error: "Not authorized to edit visits" });
    return;
  }

  const { id, guestName, guestEmail, house, startDate, endDate, notes, status, doorCode } = req.body || {};
  if (id === undefined || id === null || id === "") {
    res.status(400).json({ error: "Missing visit id" });
    return;
  }

  const patch = {};

  if (guestName !== undefined) {
    if (!guestName || typeof guestName !== "string" || guestName.length > 200) {
      res.status(400).json({ error: "Guest name is required (max 200 characters)" });
      return;
    }
    patch.guest_name = guestName;
  }

  let normalizedEmail = null;
  if (guestEmail !== undefined) {
    if (!guestEmail || typeof guestEmail !== "string" || !EMAIL_RE.test(guestEmail.trim())) {
      res.status(400).json({ error: "Guest email is missing or not a valid email address" });
      return;
    }
    normalizedEmail = guestEmail.trim().toLowerCase();
    patch.guest_email = normalizedEmail;
  }

  if (house !== undefined) {
    if (!house || !VALID_HOUSES.has(house)) {
      res.status(400).json({ error: "House is missing or not one of the known houses" });
      return;
    }
    patch.house = house;
  }

  if (startDate !== undefined) {
    if (!DATE_RE.test(startDate) || Number.isNaN(Date.parse(startDate))) {
      res.status(400).json({ error: "Arrival date must be a real date in YYYY-MM-DD form" });
      return;
    }
    patch.start_date = `${startDate}T00:00:00.000Z`;
  }

  if (endDate !== undefined) {
    if (!DATE_RE.test(endDate) || Number.isNaN(Date.parse(endDate))) {
      res.status(400).json({ error: "Departure date must be a real date in YYYY-MM-DD form" });
      return;
    }
    patch.end_date = `${endDate}T23:59:59.000Z`;
  }

  if (patch.start_date && patch.end_date && new Date(patch.end_date) < new Date(patch.start_date)) {
    res.status(400).json({ error: "Departure date is before arrival date" });
    return;
  }

  if (notes !== undefined) {
    if (notes && (typeof notes !== "string" || notes.length > 2000)) {
      res.status(400).json({ error: "Notes must be text under 2000 characters" });
      return;
    }
    patch.notes = notes || null;
  }

  if (status !== undefined) {
    if (!VALID_STATUSES.has(status)) {
      res.status(400).json({ error: "Status is not one of the known values" });
      return;
    }
    patch.status = status;
  }

  if (doorCode !== undefined) {
    if (doorCode && (typeof doorCode !== "string" || doorCode.length > 50)) {
      res.status(400).json({ error: "Door code must be text under 50 characters" });
      return;
    }
    patch.door_code = doorCode || null;
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  try {
    const dRes = await fetch(`${DIRECTUS}/items/gd_visits/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DIRECTUS_VISIT_MANAGER_TOKEN}`,
      },
      body: JSON.stringify(patch),
    });
    if (!dRes.ok) {
      const body = await dRes.text();
      throw new Error(`Directus update failed (${dRes.status}): ${body.slice(0, 300)}`);
    }
    if (normalizedEmail) {
      await addToCloudflareAllowlist(normalizedEmail);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("update-visit failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
