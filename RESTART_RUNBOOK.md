# Restart runbook — bringing Daybreak back

Daybreak was paused in July 2026 because Strava changed its API terms to bar AI
applications. See `PAUSE_RUNBOOK.md` for what was shut off. This is the reverse:
how to bring it back.

> **Updated 2026-08-18 — a retirement pass ran on top of the pause.** The July
> pause was fully reversible. This is no longer. On 2026-08-18 the Strava push
> subscription was deleted, and all 15 OAuth grants (10 Strava, 5 Google Calendar)
> were revoked on the providers' side and dropped from `oauth_tokens`. The Fly
> machine was destroyed and the `crons` block removed.
>
> What that changes below: **every athlete has to redo OAuth from scratch** —
> there are no refresh tokens left to resume from — and Step 4 is now mandatory,
> not optional. Athlete data (conversations, memory files, plans) was *not*
> deleted; a local archive sits at `transcripts/archive-2026-08-18/`.

## Precondition — do NOT skip

The reason for the pause was the Strava terms, not a technical failure. Before you
flip anything back on, the data-source problem has to actually be solved:

- Strava has explicitly OK'd this use case, **or**
- you've moved off the Strava API to another source (manual entry, Garmin/Apple
  Health via another path, file upload, etc.), **or**
- you've decided to run without live activity data.

Reversing the steps below without resolving this just puts you back in violation.
That's the real gate — the commands are the easy part.

## Sanity check before starting

- `git status` — clean tree, on `main`, up to date.
- Confirm secrets still valid: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`,
  `SUPABASE_SERVICE_ROLE_KEY`, and (if still using Strava) `STRAVA_CLIENT_SECRET`
  on both Vercel and Fly (`fly secrets list --app hammytime-worker`).

---

## Step 1 — Restore the enqueue cron

Put the `crons` block back in `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/daily-checkin", "schedule": "0 * * * *" },
    { "path": "/api/cron/calendar-reconcile", "schedule": "0 9 * * *" }
  ]
}
```

Then `git add vercel.json && git commit -m "Resume: re-enable daily cron" && git push`.
The push is the web deploy.

**The Strava keep-alive cron is already gone** (removed 2026-07-22, SPEC v0.7.58,
when the re-application was abandoned). The route and its `vercel.json` entry no
longer exist, so there's nothing to delete here — the block above is already correct.
It was a fetch-only keep-alive that kept the paused app making Strava calls during
the re-application window; normal runs fetch Strava on their own, so it stays gone.

## Step 2 — Bring the worker back

```bash
fly scale count 1 --app hammytime-worker
fly status --app hammytime-worker      # confirm one machine running
```

Do this before Step 3 so there's a drainer ready when jobs start enqueuing.

## Step 3 — Un-pause athletes

Clears only the manual pause set during the shutdown — leaves genuine
`auto_inactivity` and `dormant` athletes as they are:

```sql
UPDATE athletes
SET paused_at = NULL, pause_reason = NULL
WHERE pause_reason = 'manual';
```

Sanity check first: `SELECT count(*) FROM athletes WHERE pause_reason = 'manual';`
should match the number you paused.

## Step 4 — Re-register the Strava webhook (required)

Subscription `351755` was deleted on 2026-08-18, so there is none. Re-create it so
activity uploads trigger again:

```bash
npx tsx scripts/register-strava-webhook.ts
npx tsx scripts/register-strava-webhook.ts list   # confirm exactly one
```

## Step 5 — Every athlete reconnects (required)

`oauth_tokens` is empty. Both grants were revoked on the provider side, so nothing
refreshes and nothing resumes silently — each athlete has to run `/connect_strava`
(and `/calendar`, if they want calendar sync back) themselves. Plan the return
broadcast around that ask rather than treating it as a background detail.

Their Daybreak Google calendars were deliberately left intact, so a reconnecting
athlete may end up with a second calendar — check for an existing one before
creating.

---

## Verify it's live

- `curl -sS https://hammytime.vercel.app/api/health | jq` — all green.
- Watch worker logs on the next cron tick: `fly logs --app hammytime-worker`.
- Send yourself a message in Telegram and confirm you get a reply.
- Check the `job_queue` table drains (rows get `completed_at` set) rather than piling up.

## Tell the athletes it's back

Reuse the broadcast script with a fresh message file:

```bash
npx tsx scripts/broadcast.ts return-message.txt          # dry run
npx tsx scripts/broadcast.ts return-message.txt --send    # send
```

## If restarting long after the pause

- Check dependency drift — `@anthropic-ai/claude-agent-sdk` and the Claude model
  ids in `worker/config.ts` (`COACH_MODEL`) age fast; a model may be retired.
- Re-read `claude-status.md` and `Specs/CHANGELOG.md` to reload where things stood.
- All Strava and Google tokens were revoked on 2026-08-18, so every athlete needs
  `/connect_strava` again regardless of how long it's been (see Step 5).
