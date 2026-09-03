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

import { houseOptions } from "../src/houses.js";

const DIRECTUS = "https://cms.goddijn.net";
const CF_ACCOUNT_ID = "645dba8320bdeb991dfd3411324af9a2";
const CF_APP_ID = "dbfe011a-023f-4281-9e9a-0dc008978815";
// The guest-only policy (24h session), not the family/trusted one (30 days).
// See memory://facts/goddijn-net-cloudflare-access, "Entra ID added as a
// second login method" section, updated 2026-09-01 with the session split.
const CF_POLICY_ID = "213336b9-9a9f-4d12-a413-f9d59a0498cd";
const RESEND_FROM_ADDRESS = "stay@goddijn.net";

// Who may create a visit at all, independent of how they obtained a
// Supabase session. Today only harold@ and corinne@ are assigned to the
// Visit Manager Entra app (see memory://facts/goddijn-entra-id-tenant), so a
// domain check is the right level of strictness: it fixes the real gap
// (anyone with *any* Supabase session on this project could otherwise call
// this endpoint) without inventing new infrastructure. If a trusted
// non-@goddijn.net person ever needs to create visits themselves, extend
// this the same deliberate way gd_trusted_emails replaced a hardcoded list
// on the guide site -- don't just delete the check.
function isAuthorizedCreator(email) {
  return typeof email === "string" && email.toLowerCase().endsWith("@goddijn.net");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_HOUSES = new Set(houseOptions().map((h) => h.matchHouse));

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function validateVisitInput({ guestName, guestEmail, house, startDate, endDate, notes, doorCode }) {
  if (!guestName || typeof guestName !== "string" || guestName.length > 200) {
    return "Guest name is required (max 200 characters)";
  }
  if (!guestEmail || typeof guestEmail !== "string" || !EMAIL_RE.test(guestEmail.trim())) {
    return "Guest email is missing or not a valid email address";
  }
  if (!house || !VALID_HOUSES.has(house)) {
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
  if (notes && (typeof notes !== "string" || notes.length > 2000)) {
    return "Notes must be text under 2000 characters";
  }
  if (doorCode && (typeof doorCode !== "string" || doorCode.length > 50)) {
    return "Door code must be text under 50 characters";
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

async function createDirectusVisit({ guestName, guestEmail, house, startDate, endDate, notes, doorCode }) {
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

async function sendInvitationEmail({ creator, guestName, guestEmail, houseName, startDate, endDate, doorCode }) {
  const safeCreatorName = escapeHtml(creator.name);
  const safeGuestName = escapeHtml(guestName || "there");
  const safeHouseName = escapeHtml(houseName);
  // Door code is optional -- the 2N Access Commander integration isn't wired
  // up yet (see memory://projects/unified-guest-access-2n-cloudflare), so
  // Harold generates it manually in 2N and pastes it in here when he has
  // one. Omit the paragraph entirely rather than show an empty/placeholder
  // line when there isn't one yet.
  const doorCodeHtml = doorCode
    ? `<p>Your door code is <strong>${escapeHtml(doorCode)}</strong>.</p>`
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
        <p>When it's time, sign in at
        <a href="https://www.goddijn.net">www.goddijn.net</a> with this email address
        (${escapeHtml(guestEmail)}) to see arrival details, Wi-Fi, and everything else you'll need.</p>
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

// Stub for the future 2N Access Commander integration -- deliberately a
// no-op today, kept here so wiring in the real call later is additive, not
// a redesign. See memory://projects/unified-guest-access-2n-cloudflare for
// what's blocking the real implementation (2N root-password recovery).
async function provisionDoorCode(_visit) {
  // no-op
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
  if (!isAuthorizedCreator(creator.email)) {
    res.status(403).json({ error: "Not authorized to create visits" });
    return;
  }

  const { guestName, guestEmail, house, startDate, endDate, notes, doorCode } = req.body || {};
  const validationError = validateVisitInput({ guestName, guestEmail, house, startDate, endDate, notes, doorCode });
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }
  const normalizedGuestEmail = guestEmail.trim().toLowerCase();

  try {
    const visit = await createDirectusVisit({
      guestName, guestEmail: normalizedGuestEmail, house, startDate, endDate, notes, doorCode,
    });
    await addToCloudflareAllowlist(normalizedGuestEmail);
    await sendInvitationEmail({
      creator,
      guestName,
      guestEmail: normalizedGuestEmail,
      houseName: house,
      startDate,
      endDate,
      doorCode,
    });
    await provisionDoorCode(visit);
    res.status(200).json({ ok: true, visitId: visit?.data?.id ?? null });
  } catch (err) {
    console.error("create-visit failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
