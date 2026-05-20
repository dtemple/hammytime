# claude-status.md — hammytime project snapshot

_Updated: 2026-05-20 (session 7 — allowlist signup + Telegram deeplink page)_

---

## End goal

A multi-tenant Telegram-based marathon coaching bot for ~5–25 friends. Daily coaching loop powered by Claude Agent SDK, Strava activity data, and per-athlete memory files. Athlete onboards and communicates entirely in Telegram; a minimalist web app handles allowlist sign-up, Strava OAuth, and a read-only plan view.

---

## Current status

**Week 1, Day 1.2 complete.**

Next.js scaffold, Supabase client, full v0.3 schema, `/api/health` endpoint, Anthropic client, Sentry, Telegram scaffold, Strava OAuth, and `/signup` page are all in place. `scripts/seed-allowlist.ts` + `npm run seed:allowlist` also done.

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

---

## What is left to do (v1 sequencing)

### Week 0 — Setup

- [ ] **Day 0.1** Read Strava API ToS and Brand Guidelines end-to-end. Confirm name. Write kill criterion.
- [ ] **Day 0.2** Provision accounts and keys: Vercel, Supabase, Anthropic, Strava API app, BotFather bot, Sentry, Resend. Extract reusable prompts from personal `CLAUDE.md` into `prompts/`. Spike BYO-plan prompt template against your own onboarding answers.
- [x] **Day 0.3** Scaffold: `create-next-app` (TS, App Router, Tailwind). Supabase client + env wired. `/api/health` endpoint wired (Postgres + Anthropic checks live; Telegram/Strava stubs). Vitest configured. Anthropic client + Sentry wired.

### Week 1 — Data model, allowlist, Telegram onboarding

- [x] **Day 1.1** Migrations for full v1 schema (users, athletes, races, injuries, plans, plan_versions, memory_files, oauth_tokens, activities, messages, agent_runs, agent_run_steps, friend_allowlist, job_queue, link_tokens). RLS enabled on athlete-scoped tables (policies are a separate prompt). TS types generated. Seed self as athlete 1 — deferred to Day 1.5.
- [x] **Day 1.2** Allowlist signup + Telegram link handshake (`/signup`, one-time `link_token`, deeplink + QR).
- [ ] **Day 1.3** Telegram bot scaffold: webhook receiver, HMAC verification, inbound persist, outbound send helper, `/start <token>` handler.
- [ ] **Day 1.4** Onboarding state machine (steps 0–5, write-through to memory files, BYO-plan prompt send, David alert).
- [ ] **Day 1.5** End-to-end self-test: re-onboard from scratch, verify all DB rows, fix conversational tone.

### Week 2 — Strava OAuth + BYO-plan paste-back

- [x] Strava OAuth bones (connect route, callback, token encryption, health check) — accessible via direct URL with manually-seeded athlete UUID.
- [ ] Strava OAuth in Telegram (bot sends the athlete a /strava/connect link).
- [ ] Strava webhook subscription (app-level, route by `owner_id`).
- [ ] Token refresh cron (every 4 hours, lazy fallback).
- [ ] BYO-plan paste-back flow (detect JSON paste, Zod validate, accept or structured reject).
- [ ] Plan schema validator with human-readable errors.
- [ ] `/app/plan` read-only web view.

### Week 3 — Daily agent loop + ad-hoc Telegram replies

- [ ] Daily cron worker: enqueue `daily_checkin` jobs for athletes in 6:30–7:00 AM local window.
- [ ] Daily agent run per §3.7 (memory load, Strava pull, Claude Agent SDK, structured response, memory write-back, Telegram send, shadow-bcc mirror).
- [ ] Daily wellness battery in morning check-in.
- [ ] Ad-hoc reply mode (lighter context, Haiku router, Sonnet response).
- [ ] Per-athlete advisory lock for concurrent write safety.

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

| Milestone                                   | Target        | Status      |
| ------------------------------------------- | ------------- | ----------- |
| `/api/health` returns 200 (all green)       | End of Week 0 | Not started |
| First friend reaches `awaiting_paste` state | End of Week 1 | Not started |
| First active plan in the system             | End of Week 2 | Not started |
| Daily loop running on David for 5 days      | End of Week 4 | Not started |
| First alpha friend onboarded                | Week 5        | Not started |
| All ~25 friends onboarded                   | Week 6        | Not started |

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

## Likely next task

Day 1.3: Telegram bot scaffold — webhook receiver at `/api/tg/webhook` (HMAC secret-token verification), inbound persist to `messages`, outbound send helper (4096-char chunking, MarkdownV2), `/start <token>` handler that resolves the token → links `telegram_chat_id` to `athlete_id` → sends welcome + kicks off onboarding step 0.
