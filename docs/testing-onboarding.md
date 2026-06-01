# Testing onboarding without disturbing the real account

## What this solves

David runs one real athlete account day-to-day (real Strava, real coaching) and needs to re-test onboarding repeatedly without touching it. The obstacle: there's only one Telegram account, and athlete identity is `telegram_chat_id`, which is `UNIQUE` in the `athletes` table. Within one database, a single Telegram chat can link to exactly one athlete — so the real and test athletes can't both live there keyed to the same private chat.

The fix uses two facts:

1. A **Telegram group** has its own `chat_id` (a negative number), distinct from your private chat id. So a test athlete onboarded inside a group coexists with the real athlete in the same database — no collision.
2. A **second Telegram bot** can be DM'd / added to groups from your single Telegram account. It points at the same production database, so Strava OAuth and everything else work exactly as in prod.

Result: real athlete = your private chat with the real bot. Test athlete = a group containing a staging bot. Same prod database, fully isolated by chat id.

## One-time setup

### 1. Create a staging bot

In Telegram, message `@BotFather`:

- `/newbot` → give it a name and a username (e.g. `HammyTimeStagingBot`). Copy the **token** it gives you.
- `/setprivacy` → pick the staging bot → **Disable**. This is required: with privacy on, a bot in a group only sees commands, not your free-text onboarding answers.

### 2. Create the test group and add the bot

- Create a new Telegram group (any name).
- Add your staging bot to it.

### 3. Get the group's chat_id

Send any command in the group so the bot receives an update (commands come through even before privacy propagates):

```
/start@HammyTimeStagingBot test
```

Then ask Telegram for the chat id (substitute your staging token). Do this while the poller (`npm run bot:dev`) is **not** running, or it will steal the update:

```bash
curl -s "https://api.telegram.org/bot<STAGING_BOT_TOKEN>/getUpdates" \
  | jq '.result[].message.chat | {id, title, type}'
```

Look for `"type": "group"` (or `"supergroup"`). The `id` is negative — that's your test group. You don't have to store it anywhere; it's good to confirm it's negative, because the reset script keys its safety check on that.

### 4. Point `.env.local` at the staging bot

`.env.local` already targets the **production** Supabase project — leave that as-is. Change only the bot identity:

```
TELEGRAM_BOT_TOKEN=<staging bot token>
TELEGRAM_BOT_USERNAME=<staging bot username, no @>
TELEGRAM_BOT_MODE=polling
```

> ⚠️ Do **not** run `npm run bot:dev` with the **real** bot's token in `.env.local`. Polling with the real token competes with the production webhook and will start intercepting your real messages. Always swap to the staging token first.

### 5. Allowlist the test email (production)

Onboarding mints a token for an allowlisted email. Make sure your test email is on the prod allowlist:

```bash
npm run seed:allowlist -- davidjtemple@gmail.com
```

(`.env.local` points at prod, so this writes to the prod allowlist.)

## Running an onboarding test

> **Why you have to run `bot:dev` even though everything is on prod.** "On prod"
> means the database, Strava, and the Fly worker. It does *not* mean the staging
> bot has a listener. The production Vercel webhook is bound to the **real** bot's
> token, so it only serves the real bot — nothing in prod receives your staging
> bot's updates. Onboarding logic runs in the Next.js bot layer, so something has
> to poll the staging bot and run it. `bot:dev` (with the staging token in
> `.env.local`) is that listener. It talks to the prod database, so you still get
> all-prod for data and Strava; only the staging bot's message handling runs
> locally. Keep it running for the whole test session.

```bash
# 1. Start the staging bot (polls prod for the group's messages)
npm run bot:dev

# 2. Wipe the test athlete back to pre-onboarding (safe — see guard below)
npm run test:reset -- davidjtemple@gmail.com

# 3. Mint a fresh start token
npm run token:mint -- davidjtemple@gmail.com
```

The mint command prints a line like:

```
/start@HammyTimeStagingBot AbC123...
```

Paste that **into the test group**. The bot runs onboarding against the group's chat id. Walk through all the steps; connect Strava when prompted (the OAuth flow works because you're on prod). When you want to start over, run steps 2–3 again.

> Note: deep links (`t.me/bot?start=...`) only ever open a private chat, never a group — that's why you paste the `/start@bot <token>` command manually instead of tapping a link.

## How the safety guard works

`npm run test:reset` refuses to do anything unless the target athlete's `telegram_chat_id` is **negative** (a group chat). Your real athlete is linked to a positive private-chat id, so the script physically cannot reset it — even if you pass the wrong email by mistake.

What `test:reset` clears: plans, plan_versions, races, injuries, memory_files; resets `onboarding_state` to step 0 and clears `checkin_state`; marks outstanding link_tokens used.

What it leaves alone: the Strava connection, message history, and `agent_runs`. (To also drop Strava and re-test the connect flow from scratch, use `npx tsx scripts/disconnect-strava.ts <group_chat_id>` separately.)

## Things to know

- **All these scripts run against production**, because `.env.local` points at the prod Supabase project. `test:reset` is guarded, but `clear:plans` and `seed:allowlist` are **not** — be deliberate with them and never point them at your real email.
- **The daily cron skips the test athlete.** The enqueuer in `src/app/api/cron/daily-checkin/route.ts` excludes any athlete with a negative (group) chat_id, so the test athlete never gets a daily coaching job. This keeps the cron focused on your real athlete and avoids failed sends + DEAD alerts when the staging bot is off between sessions. (Inbound `tg_message` coaching is *not* excluded — but those jobs only fire when you actively message during a session with `bot:dev` running, and they'd send via the real bot, which isn't in the group. Testing onboarding doesn't trigger them.)
- **Test data lives in prod tables** (`agent_runs`, `messages`, `job_queue`, etc.) under the test athlete. Filter it out of any aggregate or admin view by the test athlete id if it becomes noise.

## Files

- `scripts/mint-link-token.ts` — `npm run token:mint -- <email> [ttl_minutes]`
- `scripts/reset-test-athlete.ts` — `npm run test:reset -- <email>`
