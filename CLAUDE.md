# CLAUDE.md — hammytime project orientation

## 1. Project summary

Hammytime is a multi-tenant Telegram-based marathon coaching bot for a friends-only (~5–25 athlete) audience. Each athlete onboards entirely through a Telegram conversation, generates their own training plan JSON by pasting a bot-supplied prompt template into their own Claude or ChatGPT session, then pastes the validated JSON back to the bot. A daily Vercel cron runs a Claude Agent SDK loop per athlete: it reads per-athlete memory files and the last 14 days of Strava data, generates a structured coaching response with a daily wellness battery, and delivers it to the athlete in Telegram. A minimalist Next.js 15 web app handles allowlist signup, Strava OAuth handoff, a read-only plan view, and a David-only admin console. There is no web onboarding, no payments, no mobile app — Telegram is the product surface.

---

## 2. Source-of-truth rule

**Read `Specs/SPEC.md` before any non-trivial change.**

Priority order: `Specs/SPEC.md` > `CLAUDE.md` > your prior assumptions.

If you find a conflict between `CLAUDE.md` and `Specs/SPEC.md`, the spec wins. Flag the drift in your reply so the CLAUDE.md can be corrected.

**When a new decision is made during a session** — a scope change, an architecture choice, a deferred item being pulled forward, or anything that would affect how future sessions understand the project — ask: "This looks like a spec-level decision. Do you want me to update `Specs/SPEC.md` to keep it as the source of truth?" Do not update the spec unilaterally; wait for confirmation.

---

## 3. v1 scope locks

These decisions are final for v1. Do not reopen them without a spec update.

- **Telegram-only onboarding.** The bot drives all onboarding via a conversational state machine. There is no web onboarding flow. The web app surfaces sign-up (allowlist check → deeplink) and nothing more on that path.
- **BYO-plan generation.** After onboarding, the bot sends the athlete a prompt template with their answers baked in. The athlete iterates in their own Claude or ChatGPT session and pastes the resulting JSON plan back to the bot. There is no server-side plan-generation pipeline in v1.
- **Strava required.** `activity:read_all` OAuth is mandatory. There is no manual log fallback in v1. A broken Strava connection means the agent runs without fresh data and surfaces the gap explicitly.
- **Vercel cron + `job_queue` table.** Background jobs use a Postgres `job_queue` table drained by Vercel cron with `FOR UPDATE SKIP LOCKED`. No Inngest in v1.
- **No Supabase Auth magic-link.** Identity is `telegram_chat_id` ↔ `athlete_id`. The web app reads athlete identity from a session cookie set after Telegram linking. The `/signup` page validates against `friend_allowlist` and mints a one-time `link_token`.
- **Shadow-bcc to David for first 7 days per athlete.** Every outbound bot message is also delivered to David's personal Telegram for the first 7 days per athlete (`athletes.shadow_bcc_until`). There is no 3-day human-in-the-loop approval flow.
- **Daily wellness battery on.** Morning Telegram check-in includes: readiness 1–10, soreness 1–10 + optional body-part tag, optional one-line note.
- **Sunday weekly survey off in v1.** The `weekly_survey_log.md` memory file exists in the schema but stays empty. The Sunday survey, plan-change-proposal 👍/👎 flow, and `memory_file_revisions` audit table are all deferred to v1.5.

---

## 4. Anti-goals — refuse if asked

Do not implement any of the following without a spec update and explicit instruction:

- **Inngest** or any other durable-job infrastructure. The `job_queue` table is the job queue.
- **Manual log fallback** for athletes without Strava.
- **Supabase Auth magic-link** or any email-based auth flow for athletes. `telegram_chat_id` is the durable identity.
- **Garmin scraping.** Garmin has no usable public API; do not implement scraping.
- **Web onboarding routes** (`/onboarding/*` or equivalent). Onboarding is Telegram-only.
- **`memory_file_revisions` table.** Per-write audit trail is covered by `agent_run_steps`.
- **Marketing landing page or component library** beyond plain Tailwind. The web surface is intentionally minimalist.

---

## 5. File-structure conventions

```
src/
  app/                  Next.js App Router pages and API routes
  lib/                  Shared utilities and type definitions
  server/
    telegram/           Bot webhook handler, outbound send helper, onboarding state machine
    strava/             OAuth, webhook receiver, token refresh, activity ingestion
    agent/              Daily agent loop, ad-hoc loop, memory read/write layer
  components/           React components (Tailwind only — no component library)
supabase/
  migrations/           Numbered SQL migration files
scripts/                One-off scripts (seed, smoke tests, manual plan-gen)
Specs/                  SPEC.md and any future spec documents
```

---

## 6. Commands

```bash
# Build
# TODO: fill in after scaffold (Day 0.3)
npm run build

# Lint
# TODO: fill in after scaffold
npm run lint

# Type check
# TODO: fill in after scaffold
npm run typecheck

# Test
# TODO: fill in after test harness is wired
npm run test

# Reset local database (requires supabase start)
npm run db:reset

# Generate TS types from local schema (requires supabase start)
npm run db:types

# Smoke test — verifies Supabase connection (requires supabase start + .env.local)
npm run db:smoke

# Health check (/api/health green check)
# TODO: fill in after /api/health endpoint (Day 0.3)
```

---

## 7. Session status

`claude-status.md` in the repo root is the running project snapshot. It records: where we are, what has been done, what is left, the end goal, important milestones, deferred problems, and the likely next task.

- Read `claude-status.md` at the start of every session to orient yourself.
- Update it at the end of every session — even if the only change is marking a task complete or adding a new deferred item.
- If a session ends with open threads, capture them in the "deferred / open questions" section rather than leaving them in conversation context.

---

## 8. Working agreement

Each prompt is a scoped unit of work defined by the deliverable stated in that prompt.

- If you are tempted to do something outside the stated deliverable, stop and ask before doing it.
- Do not silently expand scope.
- Do not add libraries that are not named in the deliverable.
- Do not refactor surrounding code unless the deliverable explicitly asks for it.
- Do not add error handling, fallbacks, or validation for scenarios outside the deliverable's stated scope.
- Before starting any non-trivial task, re-read the relevant section of `Specs/SPEC.md` to confirm your understanding matches the spec.
