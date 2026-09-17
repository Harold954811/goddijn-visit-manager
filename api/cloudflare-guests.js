// Lists all emails currently on the Cloudflare Access "Visit guests" policy.
// Used by the credentials dashboard (Phase 5) to show who has website access.

import { verifyCaller, isAuthorizedCreator } from "../lib/auth.js";

const CF_ACCOUNT_ID = "645dba8320bdeb991dfd3411324af9a2";
const CF_APP_ID = "dbfe011a-023f-4281-9e9a-0dc008978815";
const CF_POLICY_ID = "213336b9-9a9f-4d12-a413-f9d59a0498cd";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const caller = await verifyCaller(req.headers.authorization);
  if (!caller) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (!(await isAuthorizedCreator(caller.email))) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }

  try {
    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${CF_APP_ID}/policies/${CF_POLICY_ID}`,
      { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_ACCESS_TOKEN}` } }
    );
    const body = await cfRes.json();
    if (!cfRes.ok || !body.success) {
      throw new Error(`Cloudflare policy read failed: ${JSON.stringify(body.errors || body)}`);
    }
    const policy = body.result;
    const emails = (policy.include || [])
      .map((rule) => rule.email?.email)
      .filter(Boolean)
      .filter((e) => e !== "no-active-guest@invalid.goddijn.net"); // exclude the placeholder

    res.status(200).json({ emails: emails.map((email) => ({ email })) });
  } catch (err) {
    console.error("cloudflare-guests endpoint failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
