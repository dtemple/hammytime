# Restart runbook — bringing Daybreak back

Daybreak was paused in July 2026 because Strava changed its API terms to bar AI
applications. See `PAUSE_RUNBOOK.md` for what was shut off. This is the reverse:
how to bring it back. The pause was fully reversible — no data deleted, no athletes
disconnected — so this is mostly undoing four things.

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

**Also remove the Strava keep-alive cron (added during the pause, SPEC v0.7.57).**
The block above already omits `/api/cron/strava-refresh` — putting it back drops the
cron. Also delete the route itself so it can't be hit directly:
`git rm src/app/api/cron/strava-refresh/route.ts`. It was a fetch-only keep-alive
so the paused app kept making Strava calls; once normal runs resume they fetch
Strava again, so it's redundant and would double-fetch. Ship the deletion in the
same `commit → push`.

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

## Step 4 — Re-register the Strava webhook (only if you disabled it)

If during the pause you deleted the Strava push subscription (optional step in the
pause runbook), re-create it so activity uploads trigger again:

```bash
npx tsx scripts/register-strava-webhook.ts
```

Skip if you never disabled it.

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
- Strava tokens refresh on use; if any athlete's refresh token was revoked in the
  interim, they'll need `/connect_strava` again — the agent surfaces the gap.
