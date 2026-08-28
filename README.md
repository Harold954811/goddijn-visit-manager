# Goddijn Visit Manager

Self-service internal tool: sign in with your Goddijn Microsoft account, pick a
house, a guest, and dates, and it creates a guest visit — no manual steps
needed from anyone else.

On submit it:
1. Creates a row in the `gd_visits` Directus collection (source of truth,
   shared with the goddijn.net guest guide's visit-based access).
2. Adds the guest's email to the guest guide's Cloudflare Access allow-list.
3. Emails the guest via Resend, sent through `stay@goddijn.net` but with the
   From display name and Reply-To set to whoever created the visit, so it
   reads as genuinely from them.
4. Leaves a stub for a future 2N Access Commander door-code call (currently
   a no-op — see `memory://projects/unified-guest-access-2n-cloudflare`).

## Stack

React + Vite, deployed on Vercel. Supabase is used **only** for Microsoft
(Entra) sign-in — no visit data is stored there. See
`memory://projects/goddijn-visit-manager-app` for the full design and
`memory://facts/goddijn-entra-id-tenant` for the Entra app registration
details.

## Environment variables

| Name | Used by | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | frontend | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | frontend | Supabase anon/public key |
| `SUPABASE_URL` | `api/create-visit.js` | same project URL, server-side |
| `SUPABASE_ANON_KEY` | `api/create-visit.js` | used to verify the caller's session |
| `DIRECTUS_VISIT_MANAGER_TOKEN` | `api/create-visit.js` | create+read+update on `gd_visits` only |
| `CLOUDFLARE_ACCESS_TOKEN` | `api/create-visit.js` | Access: Apps and Policies edit |
| `RESEND_API_KEY` | `api/create-visit.js` | sending access on `goddijn.net` |

## Local dev

```
npm install
npm run dev
```

Needs a `.env.local` with the `VITE_*` vars above (never committed).
