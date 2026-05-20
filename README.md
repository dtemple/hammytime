# hammytime

Hammytime is a multi-tenant Telegram-based marathon coaching bot built for a small, friends-only group of athletes. The full product spec — architecture decisions, scope locks, database schema, and agent loop design — lives in [Specs/SPEC.md](Specs/SPEC.md). This is the Next.js 15 web app that handles allowlist signup, Strava OAuth handoff, a read-only plan view, and a David-only admin console; the coaching product itself is delivered entirely through Telegram.

## Local development

The bot runs in polling mode locally so you don't need ngrok. Set `TELEGRAM_BOT_MODE=polling` in `.env.local` (it's the default in `.env.example`). In production, `TELEGRAM_BOT_MODE=webhook` routes updates through `/api/tg/webhook` instead.

### 1. Start the local database

```bash
npx supabase start
```

This spins up a local Postgres instance via Docker. The first run pulls images and takes a minute.

### 2. Populate `.env.local`

After `supabase start` finishes, run:

```bash
npx supabase status
```

Copy the values into a new `.env.local` file (see `.env.example` for the full key list):

```
NEXT_PUBLIC_SUPABASE_URL=<API URL from supabase status>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from supabase status>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase status>
TELEGRAM_BOT_MODE=polling
```

### 3. Verify the database connection

```bash
npm run db:smoke
```

Should print `db-smoke: connection OK` and exit 0. If it fails, check that `supabase start` completed and your `.env.local` keys match `supabase status` output.

### 4. Start everything

```bash
npm run dev:all
```

This runs three processes in parallel:

| Stripe | What it does |
|--------|-------------|
| `db` (cyan) | `supabase start` — spins up local Postgres, then tails to keep the pane alive |
| `web` (magenta) | `next dev` — Next.js dev server on port 3000 |
| `bot` (yellow) | `tsx scripts/start-bot-polling.ts` — long-polling bot; logs each inbound update |

Or run them separately in three terminals:

```bash
npx supabase start          # terminal 1
npm run dev                 # terminal 2
npm run bot:dev             # terminal 3
```

Smoke test: send `/ping` to the bot in Telegram. It should reply `pong` and you'll see the update logged in the bot terminal.

### Production webhook setup

In production the bot receives updates via webhook. To register the webhook after deploying:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=$YOUR_PROD_URL/api/tg/webhook&secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Or use the convenience script:

```bash
npm run webhook:register
```

Make sure `TELEGRAM_BOT_MODE=webhook` is set in your Vercel environment variables (the default when the var is unset).
