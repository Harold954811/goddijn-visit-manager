// Website Access Console API
// Lists all emails with www.goddijn.net access (email-OTP, not Entra),
// and supports granting/revoking standing access.
//
// Two Cloudflare Access policies are read:
// - "Invited guests" (standing, 30-day session): family + trusted people
//   who have permanent access regardless of visits.
// - "Visit guests" (24h session): added automatically by Visit Manager
//   when a visit is created.
//
// Grant: adds an email to the standing "Invited guests" policy.
// Revoke: removes from whichever policy the email is on, and kills
// any active session for that email.

import { verifyCaller, isAuthorizedCreator } from "../lib/auth.js";
import { removeFromCloudflareAllowlist, revokeCloudflareSession } from "../lib/cloudflare.js";

const CF_ACCOUNT_ID = "645dba8320bdeb991dfd3411324af9a2";
const CF_APP_ID = "dbfe011a-023f-4281-9e9a-0dc008978815";
const PLACEHOLDER_EMAIL = "no-active-guest@invalid.goddijn.net";

// Policy IDs
const STANDING_POLICY_ID = "51f851f5-2523-467f-846e-ac97051dbfa8"; // "Invited guests"
const VISIT_POLICY_ID = "213336b9-9a9f-4d12-a413-f9d59a0498cd"; // "Visit guests"

function cfHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.CLOUDFLARE_ACCESS_TOKEN}`,
  };
}

async function getPolicyEmails(policyId) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${CF_APP_ID}/policies/${policyId}`,
    { headers: cfHeaders() }
  );
  const body = await res.json();
  if (!res.ok || !body.success) {
    throw new Error(`Cloudflare policy read failed: ${JSON.stringify(body.errors || body)}`);
  }
  const policy = body.result;
  const emails = (policy.include || [])
    .filter((rule) => rule.email?.email)
    .map((rule) => rule.email.email)
    .filter((e) => e !== PLACEHOLDER_EMAIL);
  return { emails, policy };
}

async function putPolicy(policyId, policy, include) {
  const { id, uid, created_at, updated_at, include: _old, ...rest } = policy;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${CF_APP_ID}/policies/${policyId}`,
    { method: "PUT", headers: cfHeaders(), body: JSON.stringify({ ...rest, include }) }
  );
  const body = await res.json();
  if (!res.ok || !body.success) {
    throw new Error(`Cloudflare policy update failed: ${JSON.stringify(body.errors || body)}`);
  }
}

export default async function handler(req, res) {
  const caller = await verifyCaller(req.headers.authorization);
  if (!caller) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (!(await isAuthorizedCreator(caller.email))) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }

  // GET: list all emails with website access
  if (req.method === "GET") {
    try {
      const [standing, visitGuests] = await Promise.all([
        getPolicyEmails(STANDING_POLICY_ID),
        getPolicyEmails(VISIT_POLICY_ID),
      ]);

      // Build a combined list, marking which group each email is in
      const allEmails = new Map();

      for (const email of standing.emails) {
        allEmails.set(email, { email, type: "standing", source: "Invited guests" });
      }
      for (const email of visitGuests.emails) {
        if (allEmails.has(email)) {
          allEmails.get(email).type = "both";
          allEmails.get(email).source = "Standing + Visit guest";
        } else {
          allEmails.set(email, { email, type: "visit", source: "Visit guest" });
        }
      }

      const rows = Array.from(allEmails.values()).sort((a, b) => {
        // Standing first, then by email
        if (a.type === "standing" && a.type !== b.type) return -1;
        if (b.type === "standing" && a.type !== b.type) return 1;
        return a.email.localeCompare(b.email);
      });

      res.status(200).json({ emails: rows });
    } catch (err) {
      console.error("website-access GET failed:", err);
      res.status(502).json({ error: err.message || "Something went wrong" });
    }
    return;
  }

  // POST: grant standing access (add to "Invited guests" policy)
  // If house is provided, also create a Directus visit row scoped to that house
  // so the guest guide only shows that house's content.
  if (req.method === "POST") {
    const { email, house } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      res.status(400).json({ error: "Valid email is required" });
      return;
    }
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const { emails, policy } = await getPolicyEmails(STANDING_POLICY_ID);
      if (!emails.includes(normalizedEmail)) {
        const newEmails = [...emails, normalizedEmail];
        await putPolicy(STANDING_POLICY_ID, policy, newEmails.map((e) => ({ email: { email: e } })));
      }

      // If a house is specified, create a Directus visit row for scoping
      let visitCreated = false;
      if (house) {
        const DIRECTUS = "https://cms.goddijn.net";
        const token = process.env.DIRECTUS_VISIT_MANAGER_TOKEN;
        // Long-lived dates: 10 years from now
        const now = new Date();
        const farFuture = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);
        const startDate = now.toISOString().slice(0, 10);
        const endDate = farFuture.toISOString().slice(0, 10);

        const visitRes = await fetch(`${DIRECTUS}/items/gd_visits`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            guest_name: email.split("@")[0],
            guest_email: normalizedEmail,
            visit_type: "Standing access",
            house,
            start_date: `${startDate}T00:00:00.000Z`,
            end_date: `${endDate}T23:59:59.000Z`,
            status: "Active",
            notes: "Granted via Website Access console",
            door_code: null,
            ac_visitor_id: null,
            visit_group_id: null,
            website_access: true,
          }),
        });
        visitCreated = visitRes.ok;
        if (!visitRes.ok) {
          const body = await visitRes.text();
          console.error("Directus visit create failed:", body.slice(0, 300));
        }
      }

      res.status(200).json({ ok: true, email: normalizedEmail, houseScoped: !!house, visitCreated });
    } catch (err) {
      console.error("website-access POST failed:", err);
      res.status(502).json({ error: err.message || "Something went wrong" });
    }
    return;
  }

  // DELETE: revoke access (remove from whichever policy, kill session)
  if (req.method === "DELETE") {
    const { email } = req.body || {};
    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }
    try {
      const normalizedEmail = email.trim().toLowerCase();

      // Check both policies and remove from whichever has it
      const [standing, visitGuests] = await Promise.all([
        getPolicyEmails(STANDING_POLICY_ID),
        getPolicyEmails(VISIT_POLICY_ID),
      ]);

      let removed = false;

      if (standing.emails.includes(normalizedEmail)) {
        const newEmails = standing.emails.filter((e) => e !== normalizedEmail);
        if (newEmails.length === 0) newEmails.push(PLACEHOLDER_EMAIL);
        await putPolicy(STANDING_POLICY_ID, standing.policy, newEmails.map((e) => ({ email: { email: e } })));
        removed = true;
      }

      if (visitGuests.emails.includes(normalizedEmail)) {
        const newEmails = visitGuests.emails.filter((e) => e !== normalizedEmail);
        if (newEmails.length === 0) newEmails.push(PLACEHOLDER_EMAIL);
        await putPolicy(VISIT_POLICY_ID, visitGuests.policy, newEmails.map((e) => ({ email: { email: e } })));
        removed = true;
      }

      // Always kill the session so they can't keep using an open tab
      await revokeCloudflareSession(normalizedEmail);

      res.status(200).json({ ok: true, removed, email: normalizedEmail });
    } catch (err) {
      console.error("website-access DELETE failed:", err);
      res.status(502).json({ error: err.message || "Something went wrong" });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
