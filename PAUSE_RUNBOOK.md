# Pause runbook — Strava API shutdown (2026-07)

> **Superseded in part on 2026-08-18.** This runbook describes the July pause,
> which was deliberately reversible. A retirement pass has since gone further:
> the push subscription is deleted, all 15 OAuth grants are revoked, the Fly
> machine is destroyed, and the `crons` block is gone. The "What NOT to do yet"
> section below no longer holds. `RESTART_RUNBOOK.md` has the current picture.

Strava changed its API terms to bar AI applications, which covers Daybreak. This
pauses the whole system: stops all recurring cost (Anthropic API + the always-on
Fly worker) and stops every Strava API call. It is fully reversible — no tokens
deleted, no athletes disconnected, no data destroyed. Run the steps in order.

## What costs money / hits Strava (so you know what each step buys)

- **Anthropic API** — spent per agent run (daily check-in, ad-hoc reply, post-activity).
- **Fly worker** (`hammytime-worker`) — one always-on machine; a standing cost even when idle.
- **Strava API** — every call happens *inside* an agent run (`fetchRecentActivities`,
  token refresh, readiness series). No run → no Strava call. There is no separate Strava cron.
- Vercel + Supabase are standing/negligible and can stay up.

There is **no global kill-switch env var** — the levers are: pause athletes, stop
the worker, stop the cron.

---

## Step 0 — Write the message

Put your copy in a plain text file, e.g. `pause-message.txt`. Written by you, not
generated. It should say: paused, no more daily check-ins, the bot won't reply for
now, nothing is deleted, you'll follow up.

## Step 1 — Broadcast it (do this first, while the bot can still send)

Dry run first — lists recipients, sends nothing:

```bash
npx tsx scripts/broadcast.ts pause-message.txt
```

Check the recipient list looks right, then send for real:

```bash
npx tsx scripts/broadcast.ts pause-message.txt --send
```

Real athletes only (negative-id test group is skipped). Each send is logged to
the `messages` table. This runs against prod via `.env.local`, same as your other
scripts. Do it before Step 3 so it doesn't depend on the worker being up.

## Step 2 — Pause every athlete

Stops the daily cron from enqueuing for anyone, and stops post-activity proactive
sends. Run against the prod DB (Supabase SQL editor or `psql`):

```sql
UPDATE athletes
SET paused_at = NOW(), pause_reason = 'manual'
WHERE paused_at IS NULL;
```

`manual` is deliberate: unlike `auto_inactivity`, an inbound message won't silently
un-pause them. (Sanity check first: `SELECT count(*) FROM athletes WHERE paused_at IS NULL;`)

## Step 3 — Stop the worker

Zeroes the Fly machine cost and any in-flight model/Strava spend:

```bash
fly scale count 0 --app hammytime-worker
```

Confirm nothing's running:

```bash
fly status --app hammytime-worker
```

In-flight jobs abort; that's fine — Step 2 means nothing new is enqueued. (If you'd
rather let a current job finish cleanly first, use `fly apps restart hammytime-worker`
and wait, then scale to 0.)

## Step 4 — Stop the enqueue cron

Belt-and-suspenders on top of Step 2 — stops the hourly function from firing at all.
Edit `vercel.json` to drop the `crons` block:

```json
{}
```

Then `git add vercel.json && git commit -m "Pause: disable daily cron" && git push`.
The push is the web deploy. (Per repo git discipline: `git status` first, ship only
this change.)

---

## What stays up

Web app, Telegram webhook, and DB remain live. Inbound messages just won't get an
agent reply once the worker's down — that's why the broadcast says so.

## What NOT to do yet

- **Don't deauthorize Strava or delete OAuth tokens.** Pausing athletes already stops
  every Strava call. Keeping the tokens means you can flip it back on without every
  friend re-doing OAuth. Only revoke if Strava requires it in writing.
- **Optional extra insurance:** disable the Strava *push subscription* so Strava stops
  sending activity webhooks (see `scripts/register-strava-webhook.ts` — deleting the
  subscription, not the tokens). A stopped worker won't call back anyway, so this is
  optional, not required.

---

## Reversing it later

1. `vercel.json` → restore the `crons` block, commit + push.
2. `fly scale count 1 --app hammytime-worker`.
3. `UPDATE athletes SET paused_at = NULL, pause_reason = NULL WHERE pause_reason = 'manual';`
   (leaves genuine dormant/auto pauses alone).
4. If you disabled the Strava push subscription, re-register it.
