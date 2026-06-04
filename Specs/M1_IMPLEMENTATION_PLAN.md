# Prompt M1 — Agent runtime in a worker container (implementation plan / handoff)

**Author:** dtemple (drafted with Claude)
**Date:** 2026-05-28 (rewritten for the v0.7 container model)
**Status:** Shipped 2026-05-29 (worker built #11, deployed + draining #13). This is now the **as-built reference for `worker/`**, not an active plan — the worker source files cite it by section number. Remaining open items (prepaid metering #12, the Strava-aware quality test) are tracked in `claude-status.md`, not here.
**Source of truth:** `Specs/SPEC.md` (v0.7) > `CLAUDE.md` > this doc. The governing spec sections are §3.1 (agent runtime), §3.3 (storage), §3.7 (daily loop), §3.8 (ad-hoc loop), §3.11 (billing), and risk #15 (isolation).

> **Why this doc was rewritten.** The earlier M1 plan migrated the daily check-in to the Agent SDK *inside a Vercel serverless function* with a hand-written custom-tool catalog. The prerequisite check killed that approach: the SDK spawns a ~240 MB native `claude` binary, and Vercel's per-function uncompressed limit is 250 MB, so it can't run there. v0.7 moves agent execution to a **Fly.io worker container** running the SDK with its **built-in tools** over a per-athlete folder of files — a near-1:1 port of the personal coach in `~/projects/health-agent`. This doc is the plan for that.

---

## 0. What this prompt delivers

A Fly.io worker container that drains `job_queue` and, for each job, runs the Claude Agent SDK over a per-athlete working directory using the SDK's built-in tools. Concretely:

1. **A worker service** (`worker/`) that polls `job_queue` with `FOR UPDATE SKIP LOCKED`, runs jobs, and handles failure/retry.
2. **A per-athlete folder lifecycle:** hydrate `memory_files` → disk, run the agent, sync changed files back to `memory_files`.
3. **The Agent SDK run** with built-in tools (Read/Write/Edit/Glob/Grep/Bash/WebSearch), `cwd` scoped to the athlete's folder, isolation enforced.
4. **A Strava-fetch script** the agent invokes via Bash to pull recent activity.
5. **Metering + prepaid balance:** record cost in `agent_runs`, decrement `athlete_credits`, block at $0 at dequeue time.
6. **Integration:** the Vercel cron becomes an enqueuer; Telegram inbound and daily runs both flow through the queue → worker.

**Out of scope (do not build — confirm before touching):**

- Stripe / real payment processing. Metering + manual admin top-up only (SPEC §3.11).
- Proposal/confirmation flows, day-overrides, the "Already done" button — deferred to a later milestone (the original M2 framing is in `Specs/archive/`, but it must be rewritten against the container model).
- `memory_file_revisions` audit table (anti-goal; `agent_run_steps` covers the trace).
- Multi-worker autoscaling. One worker machine for M1; the queue makes adding machines a later config change.
- Web search domain allowlist (SPEC §3.11 open-Q #9 — log calls during alpha, allowlist later).
- Any onboarding, Strava OAuth, or wellness-battery change.

Keep to `CLAUDE.md` §9: if something pulls you outside this list, stop and ask.

---

## 1. Prerequisite check — DONE (gate result)

The gate from the prior plan ("does `query()` spawn inside a Vercel function?") **failed on Vercel**, as designed to catch. Root cause: the linux-x64 binary is 240,420,560 bytes per the SDK's `manifest.json`; Vercel's per-function uncompressed limit is 250 MB and not configurable (AWS Lambda enforced). Both Anthropic's hosting guide and Vercel's KB document the SDK as a long-running container process. This is the structural finding that produced the v0.7 pivot — not a packaging bug to work around.

**Action for the implementer:** delete the throwaway smoke route `src/app/api/dev/agent-smoke/route.ts` (it served its purpose). The new prerequisite is a *container* smoke test — see §3.1 below.

---

## 2. Architecture after M1

```
┌────────────────────── Vercel (unchanged host) ──────────────────────┐
│  Next.js web app   signup · Strava OAuth · plan view · admin         │
│  /api/tg/webhook   Telegram inbound → enqueue tg_message job         │
│  /api/cron/*       every 30 min → enqueue daily_checkin jobs         │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │ INSERT into job_queue (Supabase)
                                 ▼
┌────────────────────── Fly.io worker container ──────────────────────┐
│  poll loop  ── claim job (FOR UPDATE SKIP LOCKED) ──┐                 │
│                                                      ▼                │
│  per job:  check balance → hydrate folder → query() with built-in   │
│            tools (Bash runs strava-fetch) → sync files back →        │
│            send Telegram reply → record agent_runs → decrement       │
│            athlete_credits → mark job complete                       │
└──────────────────────────────────────────────────────────────────────┘
```

The web app and worker are the **same repo, two deploy targets**. The worker imports the existing `src/lib` (supabase client, db-types) and `src/server/strava` code; it does **not** import Next.js request handlers. Build the worker as a plain Node entrypoint (`worker/index.ts`) compiled/run with the same TS config.

---

## 3. Files and directories to create

### 3.1 `worker/` — the container service

```
worker/
  index.ts          entrypoint: start the poll loop, handle SIGTERM (drain in-flight, then exit)
  poll.ts           claim + dispatch loop over job_queue
  jobs/
    daily-checkin.ts handler for kind='daily_checkin'
    tg-message.ts    handler for kind='tg_message'
  run-agent.ts       the shared SDK run (hydrate → query → sync → send → meter)
  folder.ts          per-athlete working-dir lifecycle (hydrate / sync / cleanup)
  isolation.ts       cwd resolution + canUseTool guard + Bash path confinement
  strava-fetch.ts    the script the agent calls via Bash (see §6)
  Dockerfile         Node 24 base + the SDK's linux-x64 binary present
  fly.toml           one machine, always-on, persistent volume for /tmp/athletes
```

**Container smoke test (the new prerequisite — do this before building handlers):** a minimal `worker/index.ts` that runs `query({ prompt: 'say ok', options: { systemPrompt: 'reply ok', settingSources: [], maxTurns: 1 } })` and logs the result, built into the Dockerfile and run on a Fly.io machine. Confirm the binary spawns and returns inside the container. This is the container equivalent of the gate that failed on Vercel — it must pass before anything else.

### 3.2 Worker dependencies and the queue claim

There is **no `job_queue` helper code yet** — only the table (`supabase/migrations/20260518000000_initial_schema.sql`) and `src/lib/db-types.ts`. Build the claim in `worker/poll.ts`. The table columns: `id, kind, key_unique, payload jsonb, run_after, locked_at, attempts, last_error, completed_at`.

Claim pattern (one row at a time for M1; the index `job_queue_run_after_locked_idx` supports it):

```sql
update job_queue
   set locked_at = now(), attempts = attempts + 1
 where id = (
   select id from job_queue
    where completed_at is null
      and locked_at is null
      and run_after <= now()
    order by run_after
    for update skip locked
    limit 1
 )
returning *;
```

On success set `completed_at = now()`. On failure set `locked_at = null`, `last_error = <msg>`, and `run_after = now() + backoff(attempts)` (exponential, cap ~30 min). A stuck `locked_at` older than a timeout (e.g. 15 min) should be reclaimable — add a `locked_at < now() - interval '15 min'` escape to the `where` so a crashed worker's jobs don't strand. Drop jobs after N attempts (e.g. 5) into a terminal `last_error` state (leave `completed_at` null, set a sentinel, and alert David).

### 3.3 `worker/folder.ts` — per-athlete working directory

The folder is the heart of the model. `memory_files` (rows of `athlete_id, file_name, content_md`) is the source of truth (SPEC §3.3).

- `hydrate(athleteId): Promise<string>` — create `<<ATHLETE_ROOT>>/<athlete_id>/`, write each `memory_files` row to `<file_name>` on disk, write the rendered system prompt (see §8) and copy `strava-fetch.ts` (or a thin wrapper) in. Return the dir path. Record a content hash per file so sync can detect changes.
- `syncBack(athleteId, dir)` — read every file in the dir, compare to the hydration hash, upsert changed files to `memory_files` (`onConflict: 'athlete_id,file_name'`, same as `scripts/import-memory-files.ts`). New files the agent created are inserted; the system prompt and the fetch script are **excluded** from sync (they're not memory). Do the upserts inside the per-athlete advisory-lock transaction (§5).
- `cleanup(dir)` — remove the dir after sync. With a persistent Fly volume you *can* keep folders warm, but for M1 cleanup-after-run keeps isolation simple and avoids stale state; revisit warming if hydration latency hurts.

`ATHLETE_ROOT` is a single configurable base (e.g. `/data/athletes` on the Fly volume). Every athlete folder is a direct child; nothing is shared between them.

### 3.4 `worker/run-agent.ts` — the shared run

Both job handlers call this. Sketch:

```ts
export type RunSource = 'daily_checkin' | 'tg_message';

export async function runAgent(athleteId: string, source: RunSource, message?: string) {
  // 1. balance gate (see §9) — caller already checked at dequeue, but re-assert
  const dir = await hydrate(athleteId);
  try {
    const system = await renderSystemPrompt(athleteId);     // §8
    const prompt = buildPrompt(source, message);            // daily: the morning trigger; tg: the athlete's text
    const q = query({
      prompt,
      options: {
        model: 'claude-sonnet-4-6',
        systemPrompt: system,                 // custom coach brief, not the claude_code preset
        settingSources: [],                   // hermetic — ignore ~/.claude and repo .claude
        cwd: dir,                             // ISOLATION: agent sees only this athlete's folder
        allowedTools: ['Read','Write','Edit','Glob','Grep','Bash','WebSearch'],
        canUseTool: makeIsolationGuard(dir),  // §5 — confine Bash, deny escape
        maxTurns: 12,
        maxBudgetUsd: 0.50,                   // per-run ceiling (SPEC §5.2)
        env: scrubbedEnv(),                   // §5 — no other athletes' secrets, no broad creds
      },
    });

    let reply = '';
    const steps: unknown[] = [];
    let result: ResultMessage | null = null;
    for await (const m of q) {
      if (m.type === 'assistant') reply = extractText(m);
      if (m.type === 'user') steps.push(m);
      if (m.type === 'result') result = m;
    }

    await syncBack(athleteId, dir);
    await sendReply(athleteId, reply, source);              // chunk at 4096; shadow-bcc David if in 7-day window
    await persistRun(athleteId, source, result, steps);     // §9 — agent_runs + agent_run_steps
    await decrementCredits(athleteId, result?.total_cost_usd ?? 0);  // §9
  } finally {
    await cleanup(dir);
  }
}
```

`maxTurns: 12` is a starting point (the daily loop reads files, runs the Strava script, maybe web-searches, writes back — more turns than the old single-shot). Tune against real runs.

### 3.5 `worker/jobs/daily-checkin.ts` and `tg-message.ts`

Thin: parse `payload` (athlete_id, and for tg-message the text), call `runAgent`. The daily handler maps to `agent_runs.kind='daily'`; tg-message maps to `'adhoc'` (see §9 / the CHECK constraint).

---

## 4. Per-athlete folder lifecycle (the contract)

For every run, in order:

1. **Balance gate** (dequeue-time, §9) — if `athlete_credits <= 0` and the athlete is past the free tier, do **not** start; instead enqueue/send a top-up message and mark the job complete. A run already in flight is never interrupted (SPEC §3.11).
2. **Advisory lock** — `pg_advisory_xact_lock(hashtext('athlete:' || athlete_id))` for the duration of hydrate+sync so a daily run and an ad-hoc reply can't clobber the same files (SPEC §3.7, §5.8). The lock wraps the DB read/write, not the whole agent run — hold it for hydrate, release while the agent thinks, re-acquire for syncBack. (Simplest correct version: serialize per athlete by holding for the whole run; acceptable at M1 scale. Note the tradeoff in code.)
3. **Hydrate** memory_files → dir.
4. **Run** the agent (cwd = dir).
5. **Sync** changed files back.
6. **Send** the reply to Telegram.
7. **Meter**: persist `agent_runs`, decrement `athlete_credits`.
8. **Cleanup** the dir.

The eight memory files mirror today's layout (`CLAUDE.md`): checkin_log, athlete_profile, race_calendar, personal_records, open_questions, wellness_log, injury_log, weekly_survey_log (empty in v1). The agent reads/writes them as real files; no write-through layer, no custom tools.

---

## 5. Isolation model (`worker/isolation.ts`) — the launch gate

SPEC risk #15: **one athlete's agent must never read another's folder or secrets.** This replaces "endless custom-tool edge cases" as the hard engineering problem and gates launch. Three layers:

1. **`cwd` scoping.** Each run sets `cwd` to the athlete's folder. Built-in Read/Write/Edit/Glob/Grep operate relative to `cwd` — but relative paths are not a security boundary on their own (an agent can write `../other-athlete/...`). Treat `cwd` as ergonomics, not enforcement.
2. **`canUseTool` guard.** `makeIsolationGuard(dir)` inspects each tool call and **denies** anything that resolves outside `dir`:
   - For Read/Write/Edit/Glob/Grep: resolve the target path against `dir`, reject if the real path escapes `dir` (path traversal, symlinks, absolute paths outside).
   - For Bash: this is the dangerous one. Confine it. Options, simplest-first: (a) deny Bash entirely except an allowlisted `node strava-fetch.ts` invocation; (b) run Bash with a restricted `cwd` and a wrapper that rejects commands referencing paths outside `dir`. Start with (a) — the only Bash the daily loop needs is the Strava fetch. Widening Bash is a deliberate, reviewed change, not a default.
   - Deny network-capable and destructive commands by default. WebSearch is allowed (it's a managed tool, not arbitrary egress); raw `curl`/`wget` via Bash is denied.
3. **Environment scrubbing.** `scrubbedEnv()` passes only what the run needs — the Anthropic key, `PATH`, and the *specific* athlete's Strava token (injected for the fetch script), and nothing else. The SDK's `env` option **replaces** the subprocess environment, so build it explicitly rather than spreading `process.env` (which would leak every athlete's secrets if they're ever in-process). Prefer fetching the Strava token from the DB inside the fetch script over putting it in env at all.

**Test this adversarially** (see §11): a folder for athlete B exists; athlete A's run attempts (via a crafted prompt) to read `../B/athlete_profile.md` or `cat /data/athletes/B/...` — both must be denied and logged. This test is a launch blocker.

---

## 6. Strava-fetch script (`worker/strava-fetch.ts`)

The agent pulls Strava data by running this via Bash, mirroring how the personal coach runs its Garmin script. It wraps the **existing** client — do not reimplement Strava.

- Reuse `fetchRecentActivities(athleteId, days)` and `StravaActivitySummary` from `src/server/strava/activities.ts`, and `hasStravaConnection`.
- CLI shape: `node strava-fetch.ts --days 14` (athlete_id comes from an env var or a file written at hydrate time, **not** a CLI arg the agent controls, so one athlete can't pass another's id). Output JSON to stdout: recent activities + 7d/28d summaries + marathon prediction if available.
- **Strava-broken handling:** if `StravaTokenBrokenError` throws, the script prints a clear `{ "strava_broken": true }` marker to stdout (exit 0) so the agent surfaces the gap to the athlete explicitly rather than silently coaching on stale data (SPEC §5.5). Do not retry-loop inside the script.

---

## 7. Cron becomes an enqueuer — `src/app/api/cron/*`

The existing daily-checkin cron route currently *runs* the check-in. After M1 it only **enqueues** (SPEC §3.1, §3.7):

- Keep auth + the athlete-selection query (athletes in their 6:30–7:00 AM local window, `status='active'`).
- For each due athlete, INSERT a `job_queue` row: `kind='daily_checkin'`, `key_unique='daily-{athlete_id}-{YYYY-MM-DD}'` (athlete-local date), `payload={ athlete_id }`. The unique key makes re-enqueues on cron overlap no-ops — exactly the idempotency the old `wellnessLogContains` guard provided, now at the queue.
- Do **not** call the agent from the Vercel function. The function returns after enqueuing.

The route may need to move/rename to reflect "enqueue" not "run", but keep the path stable if the Vercel cron config points at it — renaming the cron path is a `vercel.json`/config change; confirm before touching.

---

## 8. System prompt — `worker/prompts/coach.md`

Port from `~/projects/health-agent/CLAUDE.md` (the personal coach). Parameterize per athlete; drop the Claude-Code-specific and David-specific bits.

- Render at hydrate time: fill placeholders (athlete name, goal race + date, key active injuries, timezone) from the athlete's profile/race rows. `renderSystemPrompt(athleteId)` reads the same data the onboarding layer already loads (`loadAthleteData` in `src/server/agent/byo-plan.ts` is reusable).
- Keep the coaching brief faithful: the "look it up before asking" protocol, RPE-not-HR, prehab tiers, the daily wellness framing, the memory write-through routine (now expressed as "edit your files," since the agent has real file tools).
- The **activity-awareness rule** is mandatory and verbatim in intent: run the Strava fetch first; if the athlete already trained today, frame around what they did — never prescribe a run they already finished. This is the behavior the live test in §11 checks.
- **Voice constraints** (`CLAUDE.md` §3): must not read as AI-generated; no sycophancy; avoid the "that's not X, that's Y" pattern; avoid "genuinely / honestly / straightforward." Athletes read this voice every morning.
- Keep the static parts static so they prompt-cache across the day; per-athlete data rides in the rendered placeholders / the hydrated files, not in a freshly-rewritten prompt each run.

Acceptance: reading `coach.md` cold should feel like a coaching brief, not a config file.

---

## 9. Cost tracking now; prepaid balance deferred (SPEC §3.11)

**Revised 2026-05-28.** Under ~20 users, so the prepaid balance + decrement + $0 gate are **deferred**. Build only the tracking: rich per-run cost capture + queryable rollups, so the prepaid price can be set from real data later.

### 9.1 Recording cost (built)

`persistRun` writes `agent_runs` from the SDK `result` message: `model`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cost_usd` (the SDK's `total_cost_usd`, straight through), `result_summary`, `finished_at`. The cache-token split is load-bearing — under prompt caching, cache reads dominate input and the bare `input_tokens` won't reconcile with cost. Write one `agent_run_steps` row per captured step (`kind='tool_use'` / `'tool_result'`, `tool_name`, `input_json`, `output_json`).

`agent_runs.kind` **must** be an allowed value: the CHECK permits only `'daily' | 'adhoc' | 'weekly' | 'plan_validate'`. Map `daily_checkin → 'daily'`, `tg_message → 'adhoc'` (§13). `agent_run_steps.kind` CHECK was realigned to `('tool_use','tool_result')` to match what the worker writes (migration `20260528000001`).

### 9.2 Rollup views (built)

Migration `20260528000001_agent_cost_tracking.sql` adds two `security_invoker` views over `agent_runs`:

- `athlete_cost_daily` — per athlete per athlete-local day: runs, token split, cost.
- `athlete_cost_rollup` — cumulative + trailing 7d/28d runs and cost, first/last run.

Query these (Supabase/psql) for cumulative and weekly/daily cost per user.

### 9.3 Prepaid balance + decrement + $0 gate (DEFERRED — future #12)

Not built. When the friend set nears ~20, add `athlete_credits` (per-athlete `balance_cents` + `free_tier` flag), decrement by `cost_usd × markup` after each successful run (skip for `free_tier`), and gate at dequeue (`free_tier` false and `balance_cents <= 0` → skip, send top-up, complete the job; never truncate an in-flight run). A `// TODO(#12)` hook in `worker/run-agent.ts` marks the decrement spot. Markup is a single config constant. Use the §9.2 views to set it.

---

## 10. Telegram integration

### 10.1 Inbound → enqueue — `src/app/api/tg/webhook` + `src/server/telegram/bot.ts`

In `handleInboundText`, the `version.status === 'active'` branch currently replies with a placeholder. Change it to: persist the inbound message (`messages` row, direction='in'), then INSERT a `job_queue` row `kind='tg_message'`, `key_unique='tg-{athlete_id}-{telegram_message_id}'`, `payload={ athlete_id, text }`. The webhook returns immediately (Telegram needs a fast 200); the worker does the slow agent work and sends the reply. Leave `awaiting_paste` and the no-plan branches unchanged.

Note: the typing-indicator pattern from the old plan (`withTyping` wrapping a synchronous agent call) **no longer applies** — the agent runs in the worker, not in the webhook request. If a typing indicator is still wanted, the *worker* sends `sendChatAction` to Telegram when it claims a `tg_message` job and stops when it sends the reply. Small, optional; not a blocker.

### 10.2 `/checkin` wellness battery — `src/server/telegram/checkin/dispatcher.ts`

`onWellnessComplete` currently runs the old `runDailyCheckin` after the battery. The morning coaching read no longer hangs off the battery (it's the daily cron job now). Change `onWellnessComplete` to: persist the wellness row, clear `checkin_state`, send a short confirmation, keep the `isConcerning` nudge — and **remove** the `runDailyCheckin` call and the Strava-gate-before-LLM block. The wellness state machine itself is unchanged.

---

## 11. Tests + verification

### Unit / integration

- `worker/poll.test.ts` — claim is atomic (two concurrent claims don't grab the same row); failure sets backoff + clears `locked_at`; stale-lock reclaim works.
- `worker/folder.test.ts` — hydrate writes all rows; syncBack upserts only changed files, inserts new ones, excludes the system prompt + fetch script; survives an athlete with zero memory files.
- `worker/isolation.test.ts` (**launch gate**) — `canUseTool` denies Read/Glob/Bash targeting a path outside `dir` (traversal, absolute, symlink); allows the in-folder case and the allowlisted Strava-fetch Bash call; `scrubbedEnv` contains no other athlete's secrets.
- `worker/run-agent.test.ts` — mock the SDK `query()` to yield a scripted stream (assistant text + tool_use/tool_result + result). Assert: cwd is the athlete dir; only built-in tools allowed; `persistRun` writes an **allowed** `kind` with non-zero tokens; one `agent_run_steps` per tool call; a thrown SDK error still records a run with the error and sends the soft-fallback reply; cleanup runs in `finally`.
- Metering: `decrementCredits` subtracts cost×markup, skips free-tier; dequeue gate blocks at `balance_cents<=0` for non-free-tier and sends a top-up message.
- Update/retire tests referencing `runDailyCheckin` and the old `onWellnessComplete` agent call (`dispatcher.test.ts`, `__tests__/daily-checkin.test.ts`).

### Manual / live (on yourself — you're athlete 1)

- Run the container smoke test on Fly.io (§3.1) — binary spawns, returns. **This is the gate.** If it fails on Fly the way it failed on Vercel, stop and report.
- Enqueue a `daily_checkin` for yourself; confirm a coaching read arrives, no wellness prompt first, and the Strava fetch ran (check `agent_run_steps`).
- Log a real run on Strava, enqueue again; confirm the message references the completed run instead of prescribing it. **This is the one that matters.**
- Send an ad-hoc Telegram message; confirm a coherent reply lands via the worker.
- `/checkin`; confirm it logs wellness and does not produce a second coaching essay.
- **Isolation:** seed a second athlete folder, craft a prompt that tries to read it; confirm denial in the logs.

Run `npm run typecheck`, `npm run lint`, `npm run test` before declaring done.

---

## 12. Decommissioning

The single-shot daily-checkin layer is fully replaced:

- Delete `src/server/agent/daily-checkin.ts` (`runDailyCheckin` and its private helpers) and `src/server/agent/prompts/daily-checkin.system.md`.
- Delete `src/app/api/dev/agent-smoke/route.ts` (the Vercel smoke route).
- Move still-used pure helpers out before deleting: plan helpers (`loadActivePlan`, `extractPlannedDay`, `computePlanWeek`), check-in formatters, and `loadAthleteData` reuse — relocate the ones the worker needs into shared modules (`src/lib` or `worker/`). Don't drag dead code along.
- Keep `@anthropic-ai/sdk` in `package.json` — it's still used for onboarding LLM calls (`src/lib/anthropic.ts`, byo-plan, race-lookup). Only the agent *runtime* changed.
- The byo-plan, race-lookup, and plan-validator modules survive — they're onboarding, not the daily loop.

---

## 13. Pre-existing bug to fix in passing

`daily-checkin.ts` inserts `agent_runs.kind = 'daily_checkin'`, but the CHECK constraint only allows `'daily' | 'adhoc' | 'weekly' | 'plan_validate'` — so every run row currently fails to insert silently. The new `persistRun` must use `'daily'` / `'adhoc'`. If you want richer kinds, widen the constraint via migration — but that's a spec-touching decision; confirm first (`CLAUDE.md` §2). Default: reuse the allowed values, no migration.

---

## 14. Deferred / open (do not build now)

- **Hydration / cold-start latency.** §3.3 cleans up folders per run; if hydrate+spawn latency hurts, warm folders on the persistent Fly volume. Measure before optimizing.
- **Prompt-cache verification.** Confirm the static system prompt actually caches (watch `agent_runs.cost_usd` once real runs exist).
- **Ad-hoc context trimming** (SPEC §3.8) — M1 can run ad-hoc with the same full-folder hydrate as daily. The Haiku-router-selects-subset optimization is a cost tuning, not a correctness need; defer until token bills justify it.
- **Multi-worker scale-out, Stripe, web-search allowlist, day-overrides / proposal flows** — all later (SPEC §3.11, M2).

---

## 15. Done =

The container smoke test passes on Fly.io; the worker drains `job_queue`; a `daily_checkin` job produces a coaching read that never prescribes a run the athlete already did; ad-hoc Telegram messages route through the worker and reply; `/checkin` logs wellness only; isolation denies cross-athlete access (the launch-gate test); `agent_runs`/`agent_run_steps` populate with a valid `kind`; `athlete_credits` decrements and the $0 gate blocks non-free-tier athletes; typecheck/lint/test green. Update `claude-status.md` (`CLAUDE.md` §8).
