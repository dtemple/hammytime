# DEPLOY.md — hammytime Vercel deployment guide

_Written: 2026-05-21. Return to this when ready to deploy the landing page._

---

## Goal

Get the Next.js app live on Vercel with a real Supabase cloud project backing it. The landing page and `/signup` flow should work end-to-end. The Telegram bot stays in local polling mode — webhook registration is a separate step.

---

## Step 1 — Create Supabase production project

1. Go to [supabase.com](https://supabase.com) → New project
2. Choose a US West region (athletes are US-based, you're in Mill Valley)
3. From **Project Settings → API**, copy:
   - `NEXT_PUBLIC_SUPABASE_URL` (Project URL)
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` (anon/public key)
   - `SUPABASE_SERVICE_ROLE_KEY` (service_role key — keep secret)

---

## Step 2 — Push migrations to Supabase prod

```bash
# Link local CLI to the cloud project
# Project ref is in the URL: supabase.com/dashboard/project/<ref>
supabase link --project-ref <your-project-ref>

# Push all migrations (3 files under supabase/migrations/)
supabase db push
```

---

## Step 3 — Seed your allowlist on prod

Update `.env.local` with the prod `SUPABASE_SERVICE_ROLE_KEY`, then:

```bash
npm run seed:allowlist -- dtemple@gmail.com
```

---

## Step 4 — Create and link the Vercel project

```bash
vercel link
# Create new project, name it "hammytime"
```

Or import the GitHub repo from the Vercel dashboard for automatic preview + production deploys on push.

---

## Step 5 — Set environment variables on Vercel

Minimum set required for landing page + `/signup` to work:

| Variable | Where to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API |
| `TELEGRAM_BOT_USERNAME` | BotFather → bot username without `@` |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry → hammytime project → Client Keys |
| `SENTRY_DSN` | Same as above |
| `SENTRY_AUTH_TOKEN` | Sentry → Settings → Auth Tokens |

> `SENTRY_ORG` (`david-temple`) and `SENTRY_PROJECT` (`hammytime`) are already hardcoded in `next.config.ts` — don't need to be env vars.

Set via CLI:
```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL
# repeat for each variable above
```

**Leave unset for now** — needed later for bot/Strava, not for landing page:
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_MODE`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_VERIFY_TOKEN`, `STATE_SIGNING_KEY`, `TOKEN_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, `DAVID_TELEGRAM_CHAT_ID`

---

## Step 6 — Deploy

```bash
# Preview deploy first
vercel deploy

# Promote to production once it looks good
vercel --prod
```

If connected to GitHub, merging to `main` auto-deploys to production.

---

## Step 7 — (Optional) Custom domain

Vercel dashboard → Project → Domains → Add. You get a `.vercel.app` URL immediately regardless.

---

## Verification checklist

- [ ] `https://<vercel-url>` — landing page renders
- [ ] `/signup` — email gate works (rejects unknown emails, proceeds to deeplink for allowlisted ones)
- [ ] `/api/health` — will return `degraded` since most keys aren't set yet; that's expected
- [ ] Supabase dashboard → Table Editor → `friend_allowlist` — your seed row is present

---

## Notes

- **Bot webhook**: The `/api/webhook/telegram` endpoint exists in production but won't receive traffic until you register it with Telegram via `setWebhook`. That's a Day 1.5 / Week 2 step.
- **Sentry source maps**: `SENTRY_AUTH_TOKEN` must be set as a Vercel env var before the first build or the Sentry Webpack plugin will error and the build will fail.
- **Bot mode**: `TELEGRAM_BOT_MODE=polling` only works for local dev (`npm run bot:dev`). Don't set it on Vercel — the bot has no persistent process there. Leave it unset until webhook registration.
