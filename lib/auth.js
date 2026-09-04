// Shared by every api/ endpoint that needs to know who's calling and
// whether they're allowed to. Split out of create-visit.js (2026-09-03)
// so list/update/revoke can reuse it without duplicating or risking the
// already-working create-visit.js.

export async function verifyCaller(authHeader) {
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

// Trusted non-@goddijn.net people who may also create/manage visits.
// Reuses the SAME gd_trusted_emails Directus collection the guest guide's
// lib/cf-access.js already maintains (see memory://processes/goddijn-entra-app-onboarding-checklist)
// instead of a separate hardcoded list here -- one shared source of truth,
// no code change/deploy needed to add someone, and being in it here still
// only matters for someone ALSO assigned to the Visit Manager Entra app
// (that's the separate, first gate that gets them past sign-in at all).
// 5-minute in-memory cache since this is checked on every API call and the
// list changes rarely; a cold serverless instance just refetches once.
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
    // Directus unreachable -- fail closed to whatever we last knew, not to "allow everyone"
    return trustedEmailsCache.emails || new Set();
  }
}

export async function isAuthorizedCreator(email) {
  if (typeof email !== "string") return false;
  const lower = email.toLowerCase();
  if (lower.endsWith("@goddijn.net")) return true;
  const trusted = await fetchTrustedEmails();
  return trusted.has(lower);
}
