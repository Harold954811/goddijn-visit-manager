// Cloudflare Access allow-list + session helpers, shared by update-visit.js
// and revoke-visit.js. addToCloudflareAllowlist here mirrors the function
// of the same name in create-visit.js (kept separate there deliberately --
// see that file's own comment -- not touched by this split).

const CF_ACCOUNT_ID = "645dba8320bdeb991dfd3411324af9a2";
const CF_APP_ID = "dbfe011a-023f-4281-9e9a-0dc008978815";
// The guest-only policy (24h session), not the family/trusted one (30 days).
// See memory://facts/goddijn-net-cloudflare-access.
const CF_POLICY_ID = "213336b9-9a9f-4d12-a413-f9d59a0498cd";
const PLACEHOLDER_EMAIL = "no-active-guest@invalid.goddijn.net";

function headers() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.CLOUDFLARE_ACCESS_TOKEN}`,
  };
}

async function getPolicy() {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${CF_APP_ID}/policies/${CF_POLICY_ID}`,
    { headers: headers() }
  );
  const body = await res.json();
  if (!res.ok || !body.success) {
    throw new Error(`Cloudflare policy read failed: ${JSON.stringify(body.errors || body)}`);
  }
  return body.result;
}

// Preserves every field the read returned except read-only metadata and
// the include list -- see memory://projects/goddijn-access-security-audit
// finding M2 for why a narrower round-trip once silently erased the
// policy's session_duration override.
async function putPolicy(policy, include) {
  const { id, uid, created_at, updated_at, include: _old, ...rest } = policy;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${CF_APP_ID}/policies/${CF_POLICY_ID}`,
    { method: "PUT", headers: headers(), body: JSON.stringify({ ...rest, include }) }
  );
  const body = await res.json();
  if (!res.ok || !body.success) {
    throw new Error(`Cloudflare policy update failed: ${JSON.stringify(body.errors || body)}`);
  }
}

export async function addToCloudflareAllowlist(email) {
  const policy = await getPolicy();
  const emails = new Set((policy.include || []).map((r) => r.email?.email).filter(Boolean));
  emails.add(email);
  await putPolicy(policy, Array.from(emails).map((e) => ({ email: { email: e } })));
}

// Removes an email from the guest allow-list. Caller is responsible for
// first confirming no OTHER active visit for the same email still needs
// it -- one guest can legitimately have more than one stay.
export async function removeFromCloudflareAllowlist(email) {
  const policy = await getPolicy();
  const emails = new Set((policy.include || []).map((r) => r.email?.email).filter(Boolean));
  emails.delete(email);
  if (emails.size === 0) emails.add(PLACEHOLDER_EMAIL); // Cloudflare rejects an empty include list.
  await putPolicy(policy, Array.from(emails).map((e) => ({ email: { email: e } })));
}

// Kills any live Cloudflare Access session for this email, org-wide, so a
// revoked guest can't keep using an already-authenticated browser tab.
// Safe to call even when the email still has other legitimate access
// elsewhere -- it only forces a fresh login, it doesn't deny one.
export async function revokeCloudflareSession(email) {
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/organizations/revoke_user`,
    { method: "POST", headers: headers(), body: JSON.stringify({ email }) }
  );
}
