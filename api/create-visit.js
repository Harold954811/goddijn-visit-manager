// Creates a gd_visits row in Directus, adds the guest's email to the
// goddijn.net guest-guide's Cloudflare Access allow-list, and sends the
// guest an invitation via Resend -- From name and Reply-To set to whoever
// is actually signed in (the "creator"), so the email reads as genuinely
// from them rather than a system address. See
// memory://projects/goddijn-visit-manager-app for the full design.
//
// Security posture (2026-09-01, memory://projects/goddijn-access-security-audit
// findings H1 and H2):
//   - A valid Supabase session alone used to be enough to call this endpoint.
//     Anyone able to obtain one (e.g. if this Supabase project ever allows
//     any sign-in method besides the Entra-gated Azure provider) could grant
//     guest access and send invitation email as anyone. Fixed: the caller's
//     email must additionally be on the creator allow-list below.
//   - Guest emails are added to the "Visit guests" Cloudflare Access policy
//     (24h session, split 2026-09-01 from the family/trusted policy's 30-day
//     session -- see memory://facts/goddijn-net-cloudflare-access), not the
//     family one. A lapsed guest's browser session now expires in a day
//     instead of a month.
//   - guestEmail, house and the two dates are validated before anything is
//     written anywhere; guestName and the creator's display name are
//     HTML-escaped before going into the invitation email.
//
// Env vars required (set in the Vercel project):
//   SUPABASE_URL, SUPABASE_ANON_KEY   -- to verify the caller's session
//   DIRECTUS_VISIT_MANAGER_TOKEN      -- create+read+update on gd_visits only
//   CLOUDFLARE_ACCESS_TOKEN           -- Access: Apps and Policies edit, scoped to one account
//   RESEND_API_KEY                    -- sending access on the goddijn.net domain

import { createVisitor, getVisitorById, deleteVisitor } from "../lib/2n.js";
import { getTemplate, renderTemplate } from "../lib/email.js";

const DIRECTUS = "https://cms.goddijn.net";
const CF_ACCOUNT_ID = "645dba8320bdeb991dfd3411324af9a2";
const CF_APP_ID = "dbfe011a-023f-4281-9e9a-0dc008978815";
// The guest-only policy (24h session), not the family/trusted one (30 days).
// See memory://facts/goddijn-net-cloudflare-access, "Entra ID added as a
// second login method" section, updated 2026-09-01 with the session split.
const CF_POLICY_ID = "213336b9-9a9f-4d12-a413-f9d59a0498cd";
const RESEND_FROM_ADDRESS = "stay@goddijn.net";

// Who may create a visit at all, independent of how they obtained a
// Supabase session. Today harold@ and corinne@ are assigned to the Visit
// Manager Entra app (see memory://facts/goddijn-entra-id-tenant), so a
// domain check is the right baseline: it fixes the real gap (anyone with
// *any* Supabase session on this project could otherwise call this
// endpoint) without inventing new infrastructure. Trusted non-@goddijn.net
// people are read from the SAME gd_trusted_emails Directus collection the
// guest guide's lib/cf-access.js maintains (kept in sync with lib/auth.js's
// copy of this fetch logic, deliberately duplicated the same way
// verifyCaller is) -- one shared source of truth, no code deploy needed to
// add someone. See memory://processes/goddijn-entra-app-onboarding-checklist.
let trustedEmailsCache = { emails: null, fetchedAt: 0 };
const TRUSTED_EMAILS_TTL_MS = 5 * 60 * 1000;

async function fetchTrustedEmails() {
  const now = Date.now();
  if (trustedEmailsCache.emails && now - trustedEmailsCache.fetchedAt < TRUSTED_EMAILS_TTL_MS) {
    return trustedEmailsCache.emails;
  }
  try {
    const res = await fetch(
      "https://cms.goddijn.net/items/gd_trusted_emails?fields=email&limit=-1",
      { headers: { Authorization: `Bearer ${process.env.DIRECTUS_VISIT_MANAGER_TOKEN}` } }
    );
    if (!res.ok) return trustedEmailsCache.emails || new Set();
    const { data } = await res.json();
    const emails = new Set((data || []).map((r) => String(r.email).toLowerCase()));
    trustedEmailsCache = { emails, fetchedAt: now };
    return emails;
  } catch {
    return trustedEmailsCache.emails || new Set();
  }
}

async function isAuthorizedCreator(email) {
  if (typeof email !== "string") return false;
  const lower = email.toLowerCase();
  if (lower.endsWith("@goddijn.net")) return true;
  const trusted = await fetchTrustedEmails();
  return trusted.has(lower);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Fetch the valid houses and their 2N group mappings from Directus.
// Replaces the old static VALID_HOUSES set from src/houses.js — the
// server now validates the house name and looks up the 2N group ID
// from the source of truth, not from a client-supplied value.
let housesCache = { map: null, fetchedAt: 0 };
const HOUSES_TTL_MS = 5 * 60 * 1000;

async function fetchHousesMap() {
  const now = Date.now();
  if (housesCache.map && now - housesCache.fetchedAt < HOUSES_TTL_MS) {
    return housesCache.map;
  }
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

async function validateVisitInput({ guestName, guestEmail, house, startDate, endDate, notes, doorCode }) {
  const housesMap = await fetchHousesMap();
  if (!house || !housesMap.has(house)) {
    return "House is missing or not one of the known houses";
  }
  if (!guestName || typeof guestName !== "string" || guestName.length > 200) {
    return "Guest name is required (max 200 characters)";
  }
  if (!guestEmail || typeof guestEmail !== "string" || !EMAIL_RE.test(guestEmail.trim())) {
    return "Guest email is missing or not a valid email address";
  }
  if (!DATE_RE.test(startDate || "") || !DATE_RE.test(endDate || "")) {
    return "Arrival and departure dates must be in YYYY-MM-DD form";
  }
  if (Number.isNaN(Date.parse(startDate)) || Number.isNaN(Date.parse(endDate))) {
    return "Arrival or departure date is not a real date";
  }
  if (new Date(endDate) < new Date(startDate)) {
    return "Departure date is before arrival date";
  }
  if (notes && (typeof notes !== "string" || notes.length > 2000)) {
    return "Notes must be text under 2000 characters";
  }
  if (doorCode && (typeof doorCode !== "string" || doorCode.length > 50)) {
    return "Door code must be text under 50 characters";
  }
  return null;
}

// Validates just the house and dates (shared across all guests in a
// multi-guest submission). Returns an error string or null.
async function validateHouseAndDates(house, startDate, endDate) {
  const housesMap = await fetchHousesMap();
  if (!house || !housesMap.has(house)) {
    return "House is missing or not one of the known houses";
  }
  if (!DATE_RE.test(startDate || "") || !DATE_RE.test(endDate || "")) {
    return "Arrival and departure dates must be in YYYY-MM-DD form";
  }
  if (Number.isNaN(Date.parse(startDate)) || Number.isNaN(Date.parse(endDate))) {
    return "Arrival or departure date is not a real date";
  }
  if (new Date(endDate) < new Date(startDate)) {
    return "Departure date is before arrival date";
  }
  return null;
}

async function verifyCaller(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: process.env.SUPABASE_ANON_KEY,
    },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.email) return null;
  return {
    email: user.email,
    name: user.user_metadata?.full_name || user.user_metadata?.name || user.email,
  };
}

async function createDirectusVisit({ guestName, guestEmail, house, startDate, endDate, notes, doorCode, visitGroupId, websiteAccess }) {
  const res = await fetch(`${DIRECTUS}/items/gd_visits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DIRECTUS_VISIT_MANAGER_TOKEN}`,
    },
    body: JSON.stringify({
      guest_name: guestName,
      guest_email: guestEmail,
      visit_type: "Multi-day stay",
      house,
      start_date: `${startDate}T00:00:00.000Z`,
      end_date: `${endDate}T23:59:59.000Z`,
      status: "Active",
      notes: notes || null,
      door_code: doorCode || null,
      ac_visitor_id: null,
      visit_group_id: visitGroupId || null,
      website_access: websiteAccess !== false,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Directus create failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Adds `guestEmail` to the Visit-guests policy's include list. Reads the
// current policy and writes back every field it returned (minus read-only
// metadata), not just include/exclude/require/name/decision -- an earlier
// version of this function only round-tripped those five fields, which
// would have silently erased the policy's session_duration override (added
// 2026-09-01) on the very next visit created. See
// memory://projects/goddijn-access-security-audit, finding M2.
async function addToCloudflareAllowlist(guestEmail) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.CLOUDFLARE_ACCESS_TOKEN}`,
  };
  const getRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${CF_APP_ID}/policies/${CF_POLICY_ID}`,
    { headers }
  );
  const getBody = await getRes.json();
  if (!getRes.ok || !getBody.success) {
    throw new Error(`Cloudflare policy read failed: ${JSON.stringify(getBody.errors || getBody)}`);
  }
  const policy = getBody.result;
  const emails = new Set(
    (policy.include || [])
      .map((rule) => rule.email?.email)
      .filter(Boolean)
  );
  emails.add(guestEmail);
  const include = Array.from(emails).map((email) => ({ email: { email } }));

  // Preserve every field the read returned except read-only metadata
  // (id/uid/created_at/updated_at) and the include list, which we're
  // deliberately replacing above.
  const { id, uid, created_at, updated_at, include: _oldInclude, ...rest } = policy;
  const putBody = { ...rest, include };

  const putRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${CF_APP_ID}/policies/${CF_POLICY_ID}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify(putBody),
    }
  );
  const putBodyResult = await putRes.json();
  if (!putRes.ok || !putBodyResult.success) {
    throw new Error(`Cloudflare policy update failed: ${JSON.stringify(putBodyResult.errors || putBodyResult)}`);
  }
}

async function sendInvitationEmail({ creator, guestName, guestEmail, houseName, startDate, endDate, doorCode, websiteAccess }) {
  const safeCreatorName = escapeHtml(creator.name);
  const safeGuestName = escapeHtml(guestName || "there");
  const safeHouseName = escapeHtml(houseName);
  const doorCodeHtml = doorCode
    ? `<p>Your door code is <strong>${escapeHtml(doorCode)}</strong>.</p>`
    : "";
  const websiteHtml = websiteAccess !== false
    ? `<p>When it's time, sign in at
        <a href="https://www.goddijn.net">www.goddijn.net</a> with this email address
        (${escapeHtml(guestEmail)}) to see arrival details, Wi-Fi, and everything else you'll need.</p>`
    : "";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `${safeCreatorName} <${RESEND_FROM_ADDRESS}>`,
      reply_to: creator.email,
      to: [guestEmail],
      bcc: ["harold@goddijn.net", "corinne@goddijn.net"],
      subject: `You're invited to stay — ${houseName}`,
      html: `
        <p>Hi ${safeGuestName},</p>
        <p>${safeCreatorName} has invited you to stay at <strong>${safeHouseName}</strong>
        from <strong>${startDate}</strong> to <strong>${endDate}</strong>.</p>
        ${websiteHtml}
        ${doorCodeHtml}
        <p>See you soon,<br/>${safeCreatorName}</p>
      `,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend send failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

// Sends an email using a pre-rendered template (subject + html body).
// Used when a Directus template was fetched and rendered via lib/email.js.
async function sendTemplatedEmail({ creator, guestEmail, subject, html }) {
  const safeCreatorName = escapeHtml(creator.name);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `${safeCreatorName} <${RESEND_FROM_ADDRESS}>`,
      reply_to: creator.email,
      to: [guestEmail],
      bcc: ["harold@goddijn.net", "corinne@goddijn.net"],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend send failed (${res.status}): ${body.slice(0, 300)}`);
  }
}
// guest, scoped to the right door group for the house. If Harold provided
// a manual door code, skip this -- he may have a specific code in mind.
// If the house has no 2N devices (e.g. Rome), skip silently.
// Returns { visitorId, pin } or null.
async function provisionDoorCode({ guestName, guestEmail, startDate, endDate, doorCode, twoNGroupId }) {
  if (doorCode) return null;
  return createVisitor({ guestName, guestEmail, startDate, endDate, twoNGroupId });
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
    res.status(403).json({ error: "Not authorized to create visits" });
    return;
  }

  const { guests: guestsInput, house, startDate, endDate, notes, doorCode, templateId, existingVisitorId } = req.body || {};

  // Support both new multi-guest format (guests array) and legacy
  // single-guest format (guestName/guestEmail) for backward compatibility.
  let guests;
  if (Array.isArray(guestsInput) && guestsInput.length > 0) {
    guests = guestsInput;
  } else if (req.body.guestName && req.body.guestEmail) {
    guests = [{ guestName: req.body.guestName, guestEmail: req.body.guestEmail, websiteAccess: req.body.websiteAccess !== false }];
  } else {
    res.status(400).json({ error: "Missing guest information" });
    return;
  }

  // Validate house and dates once (shared across all guests)
  const houseValidationError = await validateHouseAndDates(house, startDate, endDate);
  if (houseValidationError) {
    res.status(400).json({ error: houseValidationError });
    return;
  }

  // Validate each guest
  for (let i = 0; i < guests.length; i++) {
    const g = guests[i];
    if (!g.guestName || typeof g.guestName !== "string" || g.guestName.length > 200) {
      res.status(400).json({ error: `Guest ${i + 1}: name is required (max 200 characters)` });
      return;
    }
    if (!g.guestEmail || !EMAIL_RE.test(g.guestEmail.trim())) {
      res.status(400).json({ error: `Guest ${i + 1}: email is missing or not a valid email address` });
      return;
    }
  }

  if (notes && (typeof notes !== "string" || notes.length > 2000)) {
    res.status(400).json({ error: "Notes must be text under 2000 characters" });
    return;
  }
  if (doorCode && (typeof doorCode !== "string" || doorCode.length > 50)) {
    res.status(400).json({ error: "Door code must be text under 50 characters" });
    return;
  }

  // Look up the 2N group ID for this house from the Directus houses map.
  const housesMap = await fetchHousesMap();
  const houseData = housesMap.get(house);
  const twoNGroupId = houseData?.twoNGroupId || null;

  // Generate a shared visit_group_id for all guests in this submission.
  // For single-guest visits, this is still set so the row is consistent.
  const visitGroupId = crypto.randomUUID();

  // Fetch the email template. If templateId is provided, use it; otherwise
  // fall back to the default for the visit type (invitation or door_only).
  const allDoorOnly = guests.every((g) => g.websiteAccess === false);
  const defaultTemplateType = allDoorOnly ? "door_only" : "invitation";
  let template = null;
  try {
    template = await getTemplate(templateId, defaultTemplateType, process.env.DIRECTUS_VISIT_MANAGER_TOKEN);
  } catch (err) {
    console.error("Failed to fetch email template (non-fatal, will use hardcoded fallback):", err);
  }

  try {
    const results = [];
    for (let idx = 0; idx < guests.length; idx++) {
      const g = guests[idx];
      const normalizedEmail = g.guestEmail.trim().toLowerCase();
      const giveWebsiteAccess = g.websiteAccess !== false;

      const visit = await createDirectusVisit({
        guestName: g.guestName,
        guestEmail: normalizedEmail,
        house, startDate, endDate, notes, doorCode,
        visitGroupId,
        websiteAccess: giveWebsiteAccess,
      });

      if (giveWebsiteAccess) {
        await addToCloudflareAllowlist(normalizedEmail);
      }

      // Provision a 2N door code for each guest individually
      let effectiveDoorCode = doorCode;
      let visitorId = null;
      try {
        if (existingVisitorId && idx === 0) {
          // Reuse existing visitor: get their PIN, delete, recreate with same PIN
          const existing = await getVisitorById(existingVisitorId);
          const existingPin = existing?.pin || null;
          try { await deleteVisitor(existingVisitorId); } catch (e) { /* non-fatal */ }
          if (existingPin && twoNGroupId) {
            const result = await createVisitor({
              guestName: g.guestName, guestEmail: normalizedEmail,
              startDate, endDate, twoNGroupId, pin: existingPin,
            });
            if (result) {
              effectiveDoorCode = result.pin;
              visitorId = result.visitorId;
            }
          } else if (!doorCode) {
            // No PIN to reuse or no 2N group — fall back to normal provisioning
            const result = await createVisitor({
              guestName: g.guestName, guestEmail: normalizedEmail,
              startDate, endDate, twoNGroupId,
            });
            if (result) {
              effectiveDoorCode = result.pin;
              visitorId = result.visitorId;
            }
          }
        } else {
          const result = await provisionDoorCode({
            guestName: g.guestName, guestEmail: normalizedEmail,
            startDate, endDate, doorCode, twoNGroupId,
          });
          if (result) {
            effectiveDoorCode = result.pin;
            visitorId = result.visitorId;
          }
        }
        if (visitorId) {
          await fetch(`${DIRECTUS}/items/gd_visits/${encodeURIComponent(visit?.data?.id)}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.DIRECTUS_VISIT_MANAGER_TOKEN}`,
            },
            body: JSON.stringify({
              door_code: effectiveDoorCode,
              ac_visitor_id: visitorId,
            }),
          });
        }
      } catch (err) {
        console.error(`2N provisioning failed for ${normalizedEmail} (non-fatal):`, err);
      }

      if (template) {
        // Use the template system
        const { subject, html } = renderTemplate(template, {
          guestName: g.guestName,
          guestEmail: normalizedEmail,
          houseName: house,
          startDate, endDate,
          doorCode: effectiveDoorCode,
          creatorName: creator.name,
        });
        await sendTemplatedEmail({ creator, guestEmail: normalizedEmail, subject, html });
      } else {
        // Fallback: use the hardcoded email function
        await sendInvitationEmail({
          creator,
          guestName: g.guestName,
          guestEmail: normalizedEmail,
          houseName: house,
          startDate, endDate,
          doorCode: effectiveDoorCode,
          websiteAccess: giveWebsiteAccess,
        });
      }

      results.push({ email: normalizedEmail, status: "ok", visitorId, pin: effectiveDoorCode });
    }

    res.status(200).json({ ok: true, visitGroupId, results });
  } catch (err) {
    console.error("create-visit failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
