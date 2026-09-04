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

// Trusted non-@goddijn.net people who may also create/manage visits --
// same small, explicit-list pattern as TRUSTED_NON_FAMILY_EMAILS on the
// guest guide (lib/cf-access.js there) started with, before it moved to a
// Directus-backed collection once more than one or two people needed it.
// Peter Dupont (family-office contact) added 2026-09-04 at Harold's
// request, once he was also assigned to the Visit Manager Entra app --
// being assigned there gets someone PAST sign-in, but this list is the
// separate, second gate that decides who the app then lets do anything.
// If this list grows past a handful of people, move it to Directus the
// same way gd_trusted_emails did, rather than letting it sprawl here.
const TRUSTED_NON_FAMILY_EMAILS = new Set(["peter.dupont@rinkelberg.com"]);

export function isAuthorizedCreator(email) {
  if (typeof email !== "string") return false;
  const lower = email.toLowerCase();
  return lower.endsWith("@goddijn.net") || TRUSTED_NON_FAMILY_EMAILS.has(lower);
}
