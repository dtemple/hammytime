# claude-status.md — hammytime project snapshot

_Updated: 2026-05-28 (session 18 — v0.7 architecture pivot + worker container built (#11): job_queue drainer, per-athlete folder lifecycle, isolation launch-gate, agent run/persist/send; 34 worker tests green)_

---

## End goal

A multi-tenant Telegram-based marathon coaching bot for ~5–25 friends. The coaching agent is the **Claude Agent SDK with its built-in tools (Read/Write/Edit/Glob/Grep/Bash/WebSearch), running in a Fly.io worker container against a per-athlete folder of files** — a near-1:1 port of David's personal coach in `~/projects/health-agent`. A daily Vercel cron *enqueues* jobs into a Postgres `job_queue`; the worker drains them (`FOR UPDATE SKIP LOCKED`), hydrates the athlete's folder from `memory_files`, runs the agent, and syncs changed files back. Athlete onboards and communicates entirely in Telegram; a minimalist web app handles allowlist sign-up, Strava OAuth, and a read-only plan view.

---

## Current status

**v0.7 architecture pivot (2026-05-28).** The coaching agent moved from "Claude Agent SDK in a Vercel serverless function with a hand-written custom-tool catalog" to "Agent SDK with built-in tools in a Fly.io worker container, one folder per athlete." Forced by a hard constraint: the SDK spawns a ~240 MB native binary that exceeds Vercel's 250 MB function limit. The custom-tool path was also the wrong design — David's personal coach already works as a plain Claude Code session over a folder of files. The lesson is captured in the wiki at `~/projects/wiki/wiki/claude-agent-sdk-deployment.md`.

This session's work (all committed):

- **`Specs/SPEC.md`** reconciled to v0.7 — fixed stale Week-3 sequencing that still described custom tools + JSON validation; now describes enqueue/drain, built-in tools, hydrate/sync-back, prose-not-JSON.
- **`Specs/M1_IMPLEMENTATION_PLAN.md`** fully rewritten for the container model (15 sections: deliverable, prereq-check gate, architecture, `worker/` layout, folder lifecycle, isolation model, strava-fetch script, cron-as-enqueuer, system-prompt port, metering + `athlete_credits`, Telegram integration, tests, decommissioning, the kind-constraint bug, deferred, done-criteria).
- **Old single-shot coaching layer deleted (#10):** `src/server/agent/daily-checkin.ts`, its system prompt, its tests, and `/api/dev/agent-smoke`. `src/server/telegram/checkin/dispatcher.ts` is now wellness-only (logs the battery, no agent call). `src/server/strava/activities.ts` exports (`fetchRecentActivities`, `hasStravaConnection`, `StravaTokenBrokenError`, `StravaActivitySummary`) are retained for the worker's strava-fetch script to reuse.
- **Specs decluttered:** pre-v0.7 prompts moved to `Specs/archive/` (CONVERSATIONAL_COACH.md, M1.md, M1.5.md, M2.md) with a README explaining they're superseded.
- **`@anthropic-ai/claude-agent-sdk` ^0.3.154** added as a dependency (prerequisite-check install).
- All tests passing after the decommission.

**Worker container built (#11, this session).** Code-complete and green (typecheck, lint, 401 tests incl. 34 new worker tests). Layout in `worker/`:

- **`config.ts`** — env-derived runtime knobs (`ATHLETE_ROOT`, `COACH_MODEL`, `MAX_TURNS`, `MAX_BUDGET_USD`, poll interval, attempt cap, stale-lock minutes, Strava lookback).
- **`isolation.ts`** (launch gate) — `ALLOWED_TOOLS = Read/Write/Edit/Glob/Grep/WebSearch` (**Bash denied entirely** — deviation, see below). `makeIsolationGuard(dir)` denies any file-tool path escaping the athlete folder (traversal, absolute, symlink via realpath of the longest existing prefix) and denies every non-allowlisted tool. `scrubbedEnv()` hands the subprocess only PATH/HOME/ANTHROPIC_API_KEY — no Supabase or athlete secrets.
- **`folder.ts`** — `hydrate` (rm+mkdir, write each `memory_files` row, plus input-only `marathon_training_plan.json` + `strava_recent.json`, sha256 per file), `syncBack` (upsert only changed/new files, skip input-only + dotfiles), `cleanup`.
- **`strava.ts`** — `buildStravaContext` pre-fetches 14d of activities + 7d/28d summaries to the folder; degrades (no retry loop) on a broken connection.
- **`system-prompt.ts`** + **`prompts/coach.md`** — coach brief ported from `~/projects/health-agent`, reframed for single-shot non-interactive runs; `buildPrompt` builds the daily-morning trigger / wraps the ad-hoc message with athlete-local date.
- **`run-agent.ts`** — the shared run: hydrate → `query()` (cwd=folder, hermetic `settingSources:[]`, isolation guard, `maxTurns`/`maxBudgetUsd`, scrubbed env) → syncBack (only on clean run) → persist → send → cleanup in `finally`. Soft-fallback reply on failure. `// TODO(#12)` credit-decrement hook left in place.
- **`persist.ts`** — records `agent_runs` (kind `daily`/`adhoc` — the allowed CHECK values) + one `agent_run_steps` row per tool call; never throws (delivery must not block on logging).
- **`send.ts`** — chunks at 4096, sends via its own grammy Bot, persists each outbound to `messages`, shadow-bccs David inside the 7-day window.
- **`poll.ts`** — `claimJob` (calls `claim_next_job` RPC), `dispatch` (routes by kind), `completeJob`, `failJob` (exponential backoff under the cap; terminal DEAD sentinel + David alert at the cap).
- **`index.ts`** — `import './env'` first, then the poll loop with greedy drain + SIGTERM/SIGINT graceful shutdown (finishes the in-flight job, then exits).
- **`env.ts`** — dotenv side-effect (loads `.env.local` before config reads env).
- **`Dockerfile`** (Node 24-slim + ripgrep, `tsx worker/index.ts`), **`.dockerignore`**, **`fly.toml`** (one always-on machine, `athlete_data` volume at `/data`, no public service), `worker:dev`/`worker:start` npm scripts.
- **Migration** `20260528000000_claim_next_job.sql` (`FOR UPDATE SKIP LOCKED` atomic single-row claim) applied locally; types regenerated.

**Not done in #11 (intentional):** the live Fly.io container smoke test (M1 §3.1 — the launch gate equivalent of the Vercel binary check) requires an actual deploy with `fly secrets`; David runs that. The metering decrement is stubbed for #12.

### Earlier (pre-pivot, still valid)

- **Prompt 18.5** — production deploy audit + grammy webhook `bot.init()` fix. Bot is live in webhook mode on Vercel; `/ping` and `/checkin` verified end-to-end.
- **Prompt 18** — Strava treated as a hard requirement; `StravaTokenBrokenError` added. (The agent-invocation half of this is superseded by v0.7 — the worker now owns the Strava fetch and the no-data refusal.)

---

## What has been done

- `Specs/SPEC.md` v0.3 written and locked (scope cuts, week 0–1 day-level detail).
- `CLAUDE.md` created in repo root (project orientation, scope locks, anti-goals, file structure, working agreement).
- `claude-status.md` created (this file).
- Next.js 15 scaffold (`create-next-app` with TS, App Router, Tailwind).
- **Supabase wired**: `@supabase/supabase-js` + `supabase` CLI + `tsx` + `dotenv` installed. `supabase init` run. `src/lib/db.ts` exports `supabaseAnon()` and `supabaseAdmin()`. `.env.example` documents all keys. `scripts/db-smoke.ts` verifies connection. `npm run db:smoke` script added.
- **Initial schema**: `supabase/migrations/20260518000000_initial_schema.sql` — all 15 tables from SPEC.md §3.3 plus `link_tokens`. FKs, NOT NULL, check constraints, indexes, RLS enabled (no policies yet). Applies cleanly via `supabase db reset`.
- **TS types**: `src/lib/db-types.ts` generated via `npm run db:types`. `db:reset` and `db:types` npm scripts added. CLAUDE.md commands updated.
- **`/api/health` endpoint**: `src/app/api/health/route.ts` — GET returns `{ status, timestamp, checks: { postgres, anthropic, telegram, strava } }`. Postgres check uses `supabaseAdmin()` with latency measurement; anthropic/telegram/strava are stubs (`configured: false`) until their clients land. Each check is wrapped in its own try/catch; `Cache-Control: no-store` set.
- **Vitest**: `vitest` + `@vitejs/plugin-react` installed as dev deps. `vitest.config.ts` configured with `@` alias. `npm run test` added. 8 tests in `src/app/api/health/route.test.ts` covering response shape, status derivation (ok/error), throw handling, stub values, and anthropic stub-vs-real behavior.
- **Anthropic client**: `@anthropic-ai/sdk` installed. `src/lib/anthropic.ts` exports `anthropicClient()` and `pingAnthropic()` (1-token Haiku 4.5 call with latency measurement). `ANTHROPIC_API_KEY` already in `.env.example`.
- **Sentry**: `@sentry/nextjs` installed. `sentry.{client,server,edge}.config.ts` + `instrumentation.ts` created. `next.config.ts` wrapped with `withSentryConfig`. `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` added to `.env.example`. Dev-only test-error route at `/api/dev/test-error` for Sentry capture verification.
- **`/api/health` Anthropic check**: `checkAnthropic()` implemented — `configured=true` when `ANTHROPIC_API_KEY` is set, `ok=true` when `pingAnthropic()` succeeds; `status=degraded` when configured but failing.
- **Strava OAuth bones**: `src/lib/crypto.ts` (libsodium secretbox encrypt/decrypt, key from `TOKEN_ENCRYPTION_KEY`). `src/lib/state-sign.ts` (HMAC-SHA256 sign/verify, 10-min expiry, key from `STATE_SIGNING_KEY`). `src/server/strava/client.ts` (`getAuthorizeUrl`, `exchangeCode`, `refreshAccessToken`, `pingStrava`). `GET /strava/connect?athlete_id=<uuid>` signs state, redirects to Strava. `GET /strava/callback` verifies state, exchanges code, upserts encrypted tokens into `oauth_tokens`. `/strava/connected` success page. `/api/health` Strava check live via `pingStrava()`. `.env.example` updated with `STATE_SIGNING_KEY` and `TOKEN_ENCRYPTION_KEY`.
- **Allowlist + signup page (Day 1.2)**: `scripts/seed-allowlist.ts` + `npm run seed:allowlist -- <email>` (idempotent upsert into `friend_allowlist`). `/signup` server component: no-email → email form; not-on-list → invite gate; on-list → mints `link_tokens` row (32-byte base64url token, 15-min TTL), renders `tg://resolve?domain=<bot>&start=<token>` deeplink + QR code via `qrcode` package.
- **Onboarding state machine (Day 1.4, steps 0 & 1)**:
  - `supabase/migrations/20260521000000_onboarding_helpers.sql` — `set_onboarding_state()` stored proc with `pg_advisory_xact_lock`
  - `src/server/telegram/onboarding/types.ts` — `OnboardingState`, `ParseResult`, `Question`, `OnboardingStep` interfaces
  - `src/server/telegram/onboarding/state.ts` — `loadOnboardingState`, `advanceQuestion`, `resetOnboarding`
  - `src/server/telegram/onboarding/memory.ts` — `upsertProfileSection` (regex replace-or-append on `athlete_profile.md`)
  - `src/server/telegram/onboarding/dispatcher.ts` — `handleOnboardingMessage`: routes inbound text, re-asks on parse failure, calls `onComplete` at step end, advances to next step
  - `src/server/telegram/onboarding/steps/00-basics.ts` — name, age, sex, timezone, days/hours per week; writes athletes row + Identity/Schedule sections
  - `src/server/telegram/onboarding/steps/01-goals.ts` — distance, target, target_time (conditional skip), meaning; writes athletes.notes + Goals section
  - `bot.ts` updated: `message:text` handler → dispatcher, real `/restart`, `handleStart` uses step-0 prompt
  - 75 tests covering all parsers + state helpers + `upsertProfileSection`

---

## What is left to do (v1 sequencing)

### Week 0 — Setup

- [ ] **Day 0.1** Read Strava API ToS and Brand Guidelines end-to-end. Confirm name. Write kill criterion.
- [ ] **Day 0.2** Provision accounts and keys: Vercel, Supabase, Anthropic, Strava API app, BotFather bot, Sentry, Resend. Extract reusable prompts from personal `CLAUDE.md` into `prompts/`. Spike BYO-plan prompt template against your own onboarding answers.
- [x] **Day 0.3** Scaffold: `create-next-app` (TS, App Router, Tailwind). Supabase client + env wired. `/api/health` endpoint wired (Postgres + Anthropic checks live; Telegram/Strava stubs). Vitest configured. Anthropic client + Sentry wired.

### Week 1 — Data model, allowlist, Telegram onboarding

- [x] **Day 1.1** Migrations for full v1 schema (users, athletes, races, injuries, plans, plan_versions, memory_files, oauth_tokens, activities, messages, agent_runs, agent_run_steps, friend_allowlist, job_queue, link_tokens). RLS enabled on athlete-scoped tables (policies are a separate prompt). TS types generated. Seed self as athlete 1 — deferred to Day 1.5.
- [x] **Day 1.2** Allowlist signup + Telegram link handshake (`/signup`, one-time `link_token`, deeplink + QR).
- [x] **Day 1.3** Telegram bot scaffold: webhook receiver, HMAC verification, inbound persist, outbound send helper, `/start <token>` handler.
- [ ] **Day 1.4** Onboarding state machine (steps 0–5, write-through to memory files, BYO-plan prompt send, David alert).
  - [x] Framework (types, state, memory, dispatcher) + Steps 0 & 1 — done
  - [x] Step 2 — goal race + tune-ups + PR baseline (Prompt 11)
  - [x] Step 3 — injury history inline keyboard (Prompt 12)
  - [x] Steps 4–5 + plan-fork (step 6) — free text, recent mileage, BYO handoff (Prompt 13)
  - [x] BYO-plan prompt send + David alert — done
- [ ] **Day 1.5** End-to-end self-test: re-onboard from scratch, verify all DB rows, fix conversational tone.
- [x] **Prompt 14b** v0.6 schema verify + plan adapter + import script.
- [x] **Prompt 15** `/checkin` command + wellness battery state machine + `wellness_log.md` write.
- [x] **Prompt 16** Daily coaching response after wellness battery — single-call Claude runtime. **Decommissioned in the v0.7 pivot (#10):** the single-shot layer is deleted; the dispatcher is wellness-only and the worker owns the coaching response.

### Week 2 — Strava OAuth + BYO-plan paste-back

- [x] Strava OAuth bones (connect route, callback, token encryption, health check) — accessible via direct URL with manually-seeded athlete UUID.
- [x] Strava OAuth in Telegram (`/connect_strava` command sends URL; callback sends confirmation) — Prompt 17.
- [ ] Strava webhook subscription (app-level, route by `owner_id`).
- [ ] Token refresh cron (every 4 hours, lazy fallback).
- [ ] BYO-plan paste-back flow (detect JSON paste, Zod validate, accept or structured reject).
- [ ] Plan schema validator with human-readable errors.
- [ ] `/app/plan` read-only web view.

### Week 3 — Daily agent loop + ad-hoc Telegram replies

- [~] Daily cron worker: existing `/api/cron/daily-checkin` runs the agent inline. **v0.7: cron becomes an enqueuer** — it inserts `job_queue` rows; the Fly.io worker drains and runs the agent. (Rework tracked in M1 plan §7, #13.)
- [x] **v0.7 #11** Worker container: Agent SDK + built-in tools over a per-athlete folder hydrated from `memory_files`, `job_queue` drainer (`FOR UPDATE SKIP LOCKED`), multi-tenant isolation guard (per-athlete `cwd`, deny-by-default, Bash denied entirely). Code-complete + green; live Fly.io smoke test pending a real deploy.
- [x] Daily wellness battery in morning check-in — `/checkin` state machine (Prompt 15).
- [ ] Ad-hoc reply mode — folded into the worker (a `tg-message` job kind), not a separate Haiku/Sonnet router.
- [ ] Per-athlete advisory lock for concurrent write safety (folder-level in the worker).

### Week 4 — Self-test + polish

- [ ] Run the full loop on yourself for 5+ days.
- [ ] Telemetry: token counts, agent step traces, error rates → Sentry + `/admin` console.
- [ ] Prompt-cache system prompt + memory files.
- [ ] Verify shadow-bcc window working.
- [ ] Ingest production memory files from personal coach into DB (replace day-1.5 seed).

### Week 5 — Closed alpha (5–10 friends)

- [ ] Allowlist gating, rate limiting, abuse controls.
- [ ] Weekly debrief calls with alpha friends.
- [ ] Hot-fix queue.
- [ ] Plan-paste escape hatch (David generates manually if friend LLM fails).

### Week 6 — Open to full friend set

- [ ] Self-serve invite flow.
- [ ] Postmortem doc.

---

## Important milestones

| Milestone                                   | Target        | Status                                         |
| ------------------------------------------- | ------------- | ---------------------------------------------- |
| `/api/health` returns 200 (all green)       | End of Week 0 | Not started                                    |
| First friend reaches `awaiting_paste` state | End of Week 1 | ✅ Wired (pending e2e test)                    |
| First active plan in the system             | End of Week 2 | ✅ Ready to import (pending `plan:import` run) |
| Daily loop running on David for 5 days      | End of Week 4 | Not started                                    |
| First alpha friend onboarded                | Week 5        | Not started                                    |
| All ~25 friends onboarded                   | Week 6        | Not started                                    |

---

## Deferred / open questions

- **Strava ToS** — must be read before any work begins (Day 0.1). Could affect scope.
- **Kill criterion** — needs to be written down before Week 1 starts.
- **BYO-plan prompt template quality** — needs to be spiked (Day 0.2) before paste-back flow is built.
- **Telegram daily message length / truncation rule** — need to sketch a ~300-char template and dry-run it before Week 3 build (SPEC §7 item 4).
- **Schema-validator safety caps** — concrete numbers (max long-run mileage, weekly ramp rate, hard-day spacing) needed before Week 2 validator build (SPEC §7 item 5).
- **v1.5 deferred items**: HealthKit/Whoop/Oura biometric ingestion, Sunday weekly survey, plan-change-proposal flow, `memory_file_revisions` table, web search domain allowlist, Strava backfill, `/app` dashboard/calendar/history pages.
- **Open questions from SPEC §4**: plan schema lock-in (v1 = existing shape), "missed run" definition (planned day passes without Strava match by 11 PM local), multiple goal races (one goal + N tune-ups), Telegram daily message format, data export / portability, account deletion (hard delete within 30 days), memory hygiene / `consolidate-memory` server equivalent.

---

## Cost tracking (precursor to #12, this session)

**Full prepaid metering (#12) is deferred** — we're under 20 users, so the `athlete_credits` balance + decrement + $0 gate aren't needed yet. Instead we added queryable per-user token/cost tracking so we can size the feature properly before building it. Migration `20260528000001_agent_cost_tracking.sql`:

- Added `cache_creation_input_tokens` + `cache_read_input_tokens` to `agent_runs`; `worker/persist.ts` now populates them. (Previously only `input_tokens` was stored — once prompt caching lands in Week 4, cache reads dominate input volume and stored tokens wouldn't reconcile with `cost_usd`.)
- Fixed a latent bug: `agent_run_steps.kind` CHECK was `('tool','llm')` but the worker writes `'tool_use'/'tool_result'`, so every step insert was failing silently. Constraint realigned to the values actually written.
- Views (both `security_invoker`): **`athlete_cost_daily`** (per athlete per athlete-local day: runs, tokens, cache split, cost) and **`athlete_cost_rollup`** (cumulative + trailing 7d/28d runs & cost, first/last run).

The `// TODO(#12)` decrement hook in `worker/run-agent.ts` stays until the full feature is built.

---

## Likely next task

**#13 — Wire cron + Telegram to the worker, end-to-end** (M1 plan §7, §10):

1. Flip `/api/cron/daily-checkin` and the Telegram webhook to *enqueue* `job_queue` rows instead of running anything inline.
2. Run the live Fly.io container smoke test (M1 §3.1 launch gate — binary spawns + returns inside the container). **Blocker if it fails the way Vercel did.**
3. End-to-end test on David as athlete 1: daily job → coaching read that doesn't re-prescribe a completed run; ad-hoc message → reply.

**#12 (full prepaid metering) remains deferred** until the friend set approaches ~20; revisit with real numbers from the cost-tracking views.

**Known deferred issue**: `agent_runs.kind` CHECK constraint allows only `('daily', 'adhoc', 'weekly', 'plan_validate')`. The worker must reuse `'daily'`/`'adhoc'` rather than introduce a new kind without a spec-level decision (see M1 plan §13).
