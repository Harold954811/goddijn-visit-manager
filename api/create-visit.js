// Creates a gd_visits row in Directus, adds the guest's email to the
// goddijn.net guest-guide's Cloudflare Access allow-list, and sends the
// guest an invitation via Resend -- From name and Reply-To set to whoever
// is actually signed in (the "creator"), so the email reads as genuinely
// from them rather than a system address. See
// memory://projects/goddijn-visit-manager-app for the full design.
//
// Env vars required (set in the Vercel project):
//   SUPABASE_URL, SUPABASE_ANON_KEY   -- to verify the caller's session
//   DIRECTUS_VISIT_MANAGER_TOKEN      -- create+read+update on gd_visits only
//   CLOUDFLARE_ACCESS_TOKEN           -- Access: Apps and Policies edit, scoped to one account
//   RESEND_API_KEY                    -- sending access on the goddijn.net domain

const DIRECTUS = "https://cms.goddijn.net";
const CF_ACCOUNT_ID = "645dba8320bdeb991dfd3411324af9a2";
const CF_APP_ID = "dbfe011a-023f-4281-9e9a-0dc008978815";
const CF_POLICY_ID = "51f851f5-2523-467f-846e-ac97051dbfa8";
const RESEND_FROM_ADDRESS = "stay@goddijn.net";

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

async function createDirectusVisit({ guestName, guestEmail, house, startDate, endDate, notes }) {
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
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Directus create failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

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

  const putRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${CF_APP_ID}/policies/${CF_POLICY_ID}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: policy.name,
        decision: policy.decision,
        include,
        exclude: policy.exclude || [],
        require: policy.require || [],
      }),
    }
  );
  const putBody = await putRes.json();
  if (!putRes.ok || !putBody.success) {
    throw new Error(`Cloudflare policy update failed: ${JSON.stringify(putBody.errors || putBody)}`);
  }
}

async function sendInvitationEmail({ creator, guestName, guestEmail, houseName, startDate, endDate }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `${creator.name} <${RESEND_FROM_ADDRESS}>`,
      reply_to: creator.email,
      to: [guestEmail],
      subject: `You're invited to stay — ${houseName}`,
      html: `
        <p>Hi ${guestName || "there"},</p>
        <p>${creator.name} has invited you to stay at <strong>${houseName}</strong>
        from <strong>${startDate}</strong> to <strong>${endDate}</strong>.</p>
        <p>When it's time, sign in at
        <a href="https://www.goddijn.net">www.goddijn.net</a> with this email address
        (${guestEmail}) to see arrival details, Wi-Fi, and everything else you'll need.</p>
        <p>See you soon,<br/>${creator.name}</p>
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

  const { guestName, guestEmail, house, startDate, endDate, notes } = req.body || {};
  if (!guestName || !guestEmail || !house || !startDate || !endDate) {
    res.status(400).json({ error: "Missing required field" });
    return;
  }
  if (new Date(endDate) < new Date(startDate)) {
    res.status(400).json({ error: "Departure date is before arrival date" });
    return;
  }

  try {
    const visit = await createDirectusVisit({ guestName, guestEmail, house, startDate, endDate, notes });
    await addToCloudflareAllowlist(guestEmail);
    await sendInvitationEmail({
      creator,
      guestName,
      guestEmail,
      houseName: house,
      startDate,
      endDate,
    });
    await provisionDoorCode(visit);
    res.status(200).json({ ok: true, visitId: visit?.data?.id ?? null });
  } catch (err) {
    console.error("create-visit failed:", err);
    res.status(502).json({ error: err.message || "Something went wrong" });
  }
}
