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

// Same allow-list rule as create-visit.js: today only harold@ and corinne@
// are assigned to the Visit Manager Entra app, so a domain check is the
// right level of strictness. See create-visit.js's own comment for the
// full reasoning if this ever needs to be loosened.
export function isAuthorizedCreator(email) {
  return typeof email === "string" && email.toLowerCase().endsWith("@goddijn.net");
}
