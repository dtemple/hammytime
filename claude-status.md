# claude-status.md — hammytime project snapshot

_Updated: 2026-06-01 (session 23 — onboarding v2 W1: Strava-forward plumbing. Data-layer only — `getLoggedInAthlete`, `getFitnessSnapshot`, `deriveTimezone` in `src/server/strava/activities.ts`, the functions W2/W3 will consume. No state-machine or callback wiring yet.)_

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

**Wellness battery made `/checkin`-only (2026-05-29).** Removed the proactive morning wellness battery. `worker/jobs/daily-checkin.ts` no longer calls `startWellnessBattery` after the agent run — the morning push is now a single coaching message. The battery is triggered only by the `/checkin` command (handler + `handleWellnessMessage` state machine unchanged, all on the Next.js bot side), which resolves the worker/dispatcher split-brain ownership. Deferred, not killed: `wellnessLogContains` kept (dead, commented) for when the proactive trigger returns. Spec-level change recorded in SPEC v0.7.2 change-log + §3.7; CLAUDE.md §4 scope lock updated. typecheck/lint/390 tests green.

**Worker deployed to Fly.io prod (#13, 2026-05-29).** The v0.7 worker is live and draining the queue end-to-end.

- **Container smoke gate passed** — a minimal `query()` spawns the native linux-x64 claude binary inside the Fly machine and returns. The constraint that killed the Vercel approach (250 MB function limit) does not apply in the container.
- **Fly app `hammytime-worker`** — one always-on `shared-cpu-1x`/1GB machine in `sjc`, `athlete_data` volume at `/data`, no public service. Secrets set via `fly secrets`: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `ATHLETE_ROOT=/data/athletes`. (Env audit against the actual code added 3 missing Strava/crypto secrets and dropped 1 unused; shadow-bcc removed so `DAVID_TELEGRAM_CHAT_ID` no longer required.)
- **Cron auth** — `CRON_SECRET` + `TELEGRAM_WEBHOOK_SECRET` confirmed in Vercel prod (`vercel env ls`). Daily cron schedule `30 13 * * *` = 13:30 UTC = 6:30am PDT / 5:30am PST.
- **Inbound webhook** — registered to `https://www.daybreak.run/api/tg/webhook` (canonical domain; vercel.app 308-redirects and Telegram won't follow). `getWebhookInfo` clean (no `last_error_message`, 0 pending). Live poller killed so nothing competes for the bot token. Final confirmation of the prod webhook-secret match needs one real inbound message from David.
- **Error-leak fix (commit 9222469)** — the SDK returns an error result (e.g. a 429) instead of throwing; the worker previously sent the raw API error text to the athlete. Now `result.subtype !== 'success'` routes to `SOFT_FALLBACK` and records the error. typecheck/lint/390 tests green.
- **Anthropic tier blocker resolved** — first real prod daily run 429'd: a cold-cache daily run needs ~146k input tokens, >> the 30k tokens/min tier-1 limit. David raised the org tier. Post-fix verification run (agent_run `cccde2f3`, ~96s, cost $0.39, `error=null`) completed cleanly and delivered a real coaching message — no leak.

**Open follow-up (deferred 2026-06-01 — do not pick up until it recurs):** the first verified prod message leaked the agent's narration — it opened with "Good. The files are updated. Here's the message for David:" before the coaching. Root cause: `worker/prompts/coach.md` §"Your final message goes straight to the athlete" already forbids that exact preamble and the agent ignored it, so a prompt-only fix is unreliable; the robust fix is a `<message>…</message>` output contract extracted in `worker/run-agent.ts` (designed in the planning session, not implemented). **David has not seen the leak recur since, so we're putting it aside** — revisit only if it shows up again in a real message. The full design is captured in the plan file `~/.claude/plans/i-m-working-on-hammytime-robust-wolf.md` if/when we return to it.

**Typing / "working on it" indicator (session 20, 2026-06-01 — shipped to prod, confirmed live).** Closes the silent gap between an athlete sending a message and the reply landing (~3s queue poll + 5–30s agent run). Two coordinated signals, one per process:

- **`src/server/telegram/bot.ts`** — webhook reacts `ctx.react('👀')` to the inbound message the instant it's enqueued (best-effort, wrapped so a failure never blocks the 200). Confirms receipt sub-second.
- **`worker/send.ts`** — new `startTyping(athleteId)` fetches `telegram_chat_id`, fires `sendChatAction('typing')` immediately, then on a 4s `setInterval` (Telegram clears typing after ~5s), and returns a stop fn.
- **`worker/run-agent.ts`** — starts the loop for `tg_message` only (daily check-ins are proactive — no one waiting), clears it in the run's `finally`. The reply send clears the indicator on Telegram's side.
- No schema/payload change (worker never needs `message_id`; reaction stays 👀 after reply — no completion swap). Fixed the `run-agent` test mock to export `startTyping`. Commit `ab762fd`, pushed to main (Vercel auto-deploy) + `fly deploy` (worker). typecheck/lint/407 tests green; David confirmed the reaction + typing render in a real chat.

**Voice-note input (session 21, 2026-06-01 — ✅ live in prod, confirmed working by David).** Athletes can send a Telegram voice note anywhere text works — onboarding free-text answers, the `/checkin` battery, and coaching. The clean part: all three inbound handlers read `ctx.message?.text ?? ''`, so we transcribe and inject the transcript onto `ctx.message.text`, then reuse the existing `handleInboundText`. No downstream refactor, no schema change — the transcript persists to `messages.body` through the inserts already there.

- **`src/lib/transcribe.ts`** (new) — `transcribeOgg(audio)` POSTs the OGG to OpenAI `gpt-4o-mini-transcribe` via native `fetch`/`FormData`. No new npm dependency. Throws on missing key / non-2xx.
- **`src/server/telegram/bot.ts`** — new `handleInboundVoice`: 👀 reaction → `ctx.getFile()` download → transcribe → inject transcript → `handleInboundText`. Registered a `message:voice` handler beside `message:text`. Empty/garbled transcript and transcription failures get friendly "type it instead" replies; webhook still 200s.
- **Transcription is raw** (no cleanup pass). `worker/prompts/coach.md` got one line telling the coach to read voice-transcribed text generously and ask when a garbled term matters.
- **New secret `OPENAI_API_KEY`** — used in the Next.js webhook only, *not* the Fly worker. Anthropic has no STT endpoint, so a separate provider is required. Set in `.env.example`, local `.env.local`, and Vercel prod (Production + Preview).
- Spec-level change recorded in **SPEC v0.7.6** — pulls forward the deferred voice item from `Specs/archive/M1.md`. Commit `33d2e49`. typecheck/lint clean.
- **Deployed + verified:** pushed to main → Vercel prod deploy `m12mf0m4d` (webhook-only, no `fly deploy` needed). First live test failed with an OpenAI `insufficient_quota` 429 (account billing, not code — the catch block correctly fell back to "type it for now"); after David added OpenAI billing credit, voice→transcript→coach-reply confirmed working end-to-end.

**Onboarding test harness (session 22, 2026-06-01).** A repeatable way to test onboarding against prod without disturbing David's real day-to-day athlete. The constraint: one Telegram account, and `athletes.telegram_chat_id` is `UNIQUE`, so the real and test athletes can't share the same private chat in one DB. Solution: onboard the test athlete inside a **Telegram group** (negative `chat_id`, distinct from the private chat) talking to a **second/staging bot** that points at the same prod database — so Strava OAuth and the full loop work as-is.

- **`scripts/mint-link-token.ts`** (`npm run token:mint -- <email> [ttl]`) — mints a `start` link_token directly (skips `/signup`) and prints a paste-ready `/start@<bot> <token>` for the group (deep links can't target groups). Warns if the email isn't allowlisted.
- **`scripts/reset-test-athlete.ts`** (`npm run test:reset -- <email>`) — resets the test athlete to pre-onboarding (clears plans/plan_versions/races/injuries/memory_files, resets `onboarding_state` to step 0, clears `checkin_state`, marks link_tokens used). **Hard guard:** refuses any athlete whose `telegram_chat_id` is not negative (i.e. not a group), so it can never touch the real athlete. Leaves Strava/messages/agent_runs intact.
- **Runbook: `docs/testing-onboarding.md`** — full one-time setup (BotFather staging bot, disable privacy, create group, get group id, `.env.local` swap) + the per-run loop. Read this first.
- Note: these scripts run against prod (`.env.local` targets prod Supabase). The staging bot's listener is `npm run bot:dev` (the prod Vercel webhook is bound to the real bot token, so it can't serve the staging bot) — must run for the whole test session.
- **Daily cron now excludes group-chat (test) athletes** (`src/app/api/cron/daily-checkin/route.ts` skips negative `telegram_chat_id`). This stops the test athlete from generating failed jobs + DEAD alerts when the staging bot is off, and fixes a latent bug: the cron picked `onboarded[0]` of all onboarded athletes, so a present test athlete could have starved the real athlete of its daily coaching.

**Onboarding v2 — W1 Strava-forward plumbing (session 23, 2026-06-01).** First build step of the onboarding-v2 redesign (`Specs/ONBOARDING_V2.md`). W0 (test harness) landed in session 22; W1 builds the Strava **data layer** that W2 (state-machine restructure) and W3 (template plan-gen) will consume to pre-fill onboarding buttons. **Pure data layer — returns structured values, writes nothing, touches no state machine.** All in `src/server/strava/activities.ts`:

- **`getLoggedInAthlete(athleteId)` → `StravaProfile | null`** — net-new `GET /athlete` call (profile previously came only from the OAuth token-exchange response). Every field `?? null` for privacy-hidden data; throws `StravaTokenBrokenError` on a 401 that survives a refresh retry. Lives in `activities.ts` (not `client.ts`) to avoid the `client ↔ activities` import cycle.
- **`getFitnessSnapshot(athleteId, days=56)` → `StravaFitnessSnapshot | null`** — 8-week training snapshot: recent (trailing-4wk) + avg (8wk) weekly mileage, longest run, runs/week, clamped `suggested_days_per_week` (3–6), `dominant_long_run_weekday` (mode of each week's longest run), road/trail mix. `null` for no Strava connection; **zero-count snapshot** for connected-but-no-activities (so W2 knows to fall back to asking).
- **`deriveTimezone(activities, profile?)` → `string | null`** — parses the IANA zone from the most recent activity's Strava `timezone` field; returns `null` when none (W2 asks/confirms). **No city→IANA library** — deliberate scope call (David signed off).
- **Supporting:** added `timezone` to `StravaActivitySummary` + `mapActivity` (additive); threaded optional `perPage` (default 50) through `fetchRecentActivities`/`callStravaActivities` so the snapshot pulls `per_page=200` over 8 weeks without disturbing the worker's 14-day callers.
- **Tests:** new `activities.test.ts`, 11 cases — profile mapping, privacy-nulls, no-connection, 401→`StravaTokenBrokenError`, snapshot math on a fixed fixture set, empty-history fallback, timezone parsing. typecheck/lint/**418 tests** green (407 prior + 11 new).

**Two deliberate deviations from the literal W1 bullet list, both confirmed with David:** (1) callback-resume wiring (`/strava/callback` kicking onboarding forward) **deferred to W2** — the A1 step it would resume into doesn't exist until the state-machine restructure, and the A1 confirmation copy belongs there. (2) timezone falls back to `null` rather than city→IANA (no dataset/library).

**Pre-existing latent issue noted, left alone (out of W1 scope):** `fetchRecentActivities` throws a plain `Error` on a persistent 401, not `StravaTokenBrokenError`, so the worker's typed-error branch (`worker/strava.ts:90`) only ever fires for the new `getLoggedInAthlete`. Harmless today (worker degrades to `broken: true` either way), but the friendlier "expired or revoked" message never reaches the activity path. Worth a real fix if token breakage becomes common.

**Deploy:** Next.js-side plumbing not yet wired into any route → Vercel auto-deploy on push to main. No `fly deploy` needed (worker behavior unchanged — additive type field + unused new functions).

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

**Onboarding v2 — W2 (state-machine restructure).** The next workstream in `Specs/ONBOARDING_V2.md`. Replaces the 7 rigid steps with the Phase-A button beats (goal, experience, race via `lookupRace`, days/week, long-run day, injury quick-check) + the enrichment-dump step (inline LLM extraction → echo → confirm). W2 consumes the W1 data layer (`getLoggedInAthlete`, `getFitnessSnapshot`, `deriveTimezone`) to pre-fill buttons, and is where the **Strava-forward ordering** (A0→A1) and the **callback-resume wiring deferred from W1** get built (the A1 confirmation copy lives with that step). Model three goal states: committed race, race-intended-but-unselected (A4b), and day-to-day-no-race. W2 needs W1 (done); W4 needs W2 + W3. David is kicking W2 off in a new thread.

---

### Prior close-out items (v0.7 worker)

**#13 is done** — worker deployed, queue draining, daily run verified clean. Remaining close-out items:

1. **Confirm the inbound webhook end-to-end** — David sends one real Telegram message; verify it persists as an inbound `messages` row and enqueues a `tg_message` job the worker drains into a reply. This is the only unverified link in the prod path.
2. **Strava-aware quality test** (M1 §11) — log a real run, confirm the daily message *references the completed run* instead of prescribing it. Needs David's real Strava data.
3. ~~**Tune the coach prompt** — stop the agent's narration leak.~~ **Deferred 2026-06-01** — hasn't recurred since the first run; design captured, set aside until it shows up again (see the "Open follow-up" note above).

**#12 (full prepaid metering) remains deferred** until the friend set approaches ~20; revisit with real numbers from the cost-tracking views.

**#12 (full prepaid metering) remains deferred** until the friend set approaches ~20; revisit with real numbers from the cost-tracking views.

**Known deferred issue**: `agent_runs.kind` CHECK constraint allows only `('daily', 'adhoc', 'weekly', 'plan_validate')`. The worker must reuse `'daily'`/`'adhoc'` rather than introduce a new kind without a spec-level decision (see M1 plan §13).
