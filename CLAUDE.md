# CLAUDE.md — hammytime project orientation

## 1. Project summary

Hammytime is a multi-tenant Telegram-based marathon coaching bot for a friends-only (~5–25 athlete at launch) audience. Each athlete onboards entirely through a Telegram conversation, generates their own training plan JSON by pasting a bot-supplied prompt template into their own Claude or ChatGPT session, then pastes the validated JSON back to the bot. The coaching agent is the **Claude Agent SDK with its built-in tools, running in a Fly.io worker container against a per-athlete folder of files** (v0.7 — a near-1:1 port of the personal coach in `~/projects/health-agent`); a daily Vercel cron _enqueues_ jobs into a Postgres `job_queue` that the worker drains. Each run reads the athlete's memory files and the last 14 days of Strava data, generates a coaching response with a daily wellness battery, and delivers it in Telegram. A minimalist Next.js 15 web app handles allowlist signup, Strava OAuth handoff, a read-only plan view, and a David-only admin console. There is no web onboarding and no mobile app — Telegram is the product surface. Billing is free for the first ~20 friends, then prepaid pay-per-usage. **See the SPEC.md v0.7 change-log entry for the architecture pivot rationale (the Agent SDK can't run in a Vercel function).**

---

## 2. Source-of-truth rule

**Read the relevant section of `Specs/SPEC.md` before any non-trivial change.** The spec is structured by section (§1–§8, and §3.1–§3.11 within the implementation plan); read the section(s) your change touches rather than the whole file. Then check `Specs/CHANGELOG.md` for a newer entry that supersedes that section — several in-flight features are recorded there as the authoritative record until their §3.x body is rewritten.

Priority order: `Specs/SPEC.md` (+ `Specs/CHANGELOG.md`) > `CLAUDE.md` > your prior assumptions.

If you find a conflict between `CLAUDE.md` and `Specs/SPEC.md`, the spec wins. Flag the drift in your reply so the CLAUDE.md can be corrected.

**When a new decision is made during a session** — a scope change, an architecture choice, a deferred item being pulled forward, or anything that would affect how future sessions understand the project — ask: "This looks like a spec-level decision. Do you want me to update `Specs/SPEC.md` to keep it as the source of truth?" Do not update the spec unilaterally; wait for confirmation.

---

## 3. Working with David

This section is personal context — who David is and how he likes to work — to help you make better judgment calls during the build. Project rules live in the other sections; this one is about communication and operating style. (For deeper context, the hub page is `[[david-temple]]` in his personal wiki at `~/projects/wiki`.)

### Background relevant to building this

- Spent 8.5 years at Pinterest, most recently as VP of Product Management running an incubation team. Left in April 2026 to pursue independent small software businesses. Founded Hello Scout earlier in his career.
- Full-stack solo developer in practice: ships substantial infrastructure in Node.js, Python, Supabase, and TypeScript without hand-holding. You can skip basic-concept explanations and go straight to the decision or the diff.
- Hammytime is in the "personal-ish" bucket — friends-only, no monetization in v1. It is not a business idea being validated; David is actually building it. The "don't build before validating" rule that applies to his business work does **not** apply here. Default to making forward progress on the spec.

### Output preferences

- Direct and informative. No hedging, no sycophancy, no reinforcing ideas he already had.
- Longer and more detailed over terse when detail adds value. Bullet-formatted where structure helps; prose where it doesn't.
- Include context with answers so he can evaluate reasoning, not just conclusions. When you make a call (which library, which pattern, which trade-off), show why — not just what.
- Honest assessment over encouragement. If a plan has a hole, name the hole. If a decision looks wrong, push back with the evidence.

### Hard rules for generated copy

These apply to any user-facing text you produce in this repo: bot messages, prompt templates the athletes see, web copy, error strings, anything an athlete will read. They also apply to anything David himself will read inside the repo — comments, docs, commit messages.

- **Must not read as AI-generated.** This is a load-bearing constraint, not a nice-to-have. Especially important for the Telegram bot voice, which athletes will read every day.
- **No sycophancy.** Don't open responses (or bot messages) with "Great question," "Awesome," or similar. Don't praise the user for asking.
- **Avoid the "That's not X. That's genuine Y." pattern.** David has called this out specifically as a tell.
- **Follow the humanizer guidelines** at https://github.com/blader/humanizer. It catches: inflated symbolism, promotional language, vague attributions, rule of three, AI vocabulary, passive voice, negative parallelisms, filler phrases.
- Avoid the words "genuinely," "honestly," "straightforward," and "niggle."

### Decision-making style

David runs **analytical bookends around intuitive execution**:

1. Analytical entry — wants data and evidence before committing to a direction.
2. Intuitive execution — once committed, dives in and leans on momentum to the next milestone.
3. Analytical evaluation — at the milestone, pulls back up and assesses honestly.
4. Repeat.

Implication for you: at the start of a meaningful task, bring data and evidence to the choice. Mid-execution, don't relitigate. At completion, deliver an honest assessment of what worked and what didn't — including misses you'd otherwise be tempted to soften.

### What to push back on

David has flagged these in his own work as failure modes. They apply more weakly here than to his business ideas (hammytime is personal-ish), but watch for them anyway:

- **Scope creep.** If a task is expanding beyond what was asked, stop and confirm before continuing. The "Working agreement" section below is the hard version of this.
- **Building without need.** If you find yourself adding a library, abstraction, or fallback that the deliverable didn't ask for, stop.
- **Reflexive over-validation.** Don't add error handling, retries, or sanity checks for scenarios outside the stated scope.

### Hard constraints

- Based in Mill Valley, CA — Pacific time. When schedules, times, or cron expressions come up, default to America/Los_Angeles unless told otherwise.
- Two kids, ages 9 and 6. Working time has real-world bounds around school hours and family time. If a task looks like it'll take longer than the session window, say so up front rather than running over.

### Skills and idioms to lean on

- **File-based agent memory** — the per-athlete memory file pattern in hammytime is the same shape as David's own marathon-coach Claude Project: a plan JSON that never gets overwritten, a latest-state file that gets overwritten each session, and an append-only log. This pattern is in his bones; reuse the names and shapes where appropriate.
- **BYOK / per-user secrets** — he has done this before. Encrypted-at-rest API keys and OAuth tokens are familiar territory.
- **Strava OAuth + token refresh** — he has shipped this on a personal project. Don't over-explain.

---

## 4. v1 scope locks

These decisions are final for v1. Do not reopen them without a spec update.

- **Telegram-only onboarding.** The bot drives all onboarding in chat. There is no web onboarding flow. The web app surfaces sign-up — an allowlist check that branches to a Telegram deeplink (invited) or a waitlist capture (not invited, v0.7.17) — and nothing more on that path. **Onboarding v3 (signed off 2026-06-04, shipped 2026-06-05, SPEC v0.7.23) is the default flow and replaced v2's button-forward state machine with a slot-filling conversational intake — one global slot schema filled from freeform text/voice on Sonnet, chips for ≤3-option answers, an orientation + ready gate, an `/edit_profile` menu, and the uncatalogued-goal pocket for out-of-catalog goals (W8). `ONBOARDING_V3` is a kill-switch back to v2 (v3 is on unless the var is explicitly `false`/`0`/`off`), not an enable-switch. Only the eval harness (V3-W5) is deferred. See `Specs/ONBOARDING_V3.md`. Telegram-only and Strava-required are unchanged.**
- **Template-first plan generation (v2 — supersedes BYO; signed off 2026-06-01, SPEC v0.7.8).** After onboarding, the agent selects a plan template (distance × experience tier) from the athlete's onboarding + Strava signal, scales it to current volume and weeks-to-race, lightly customizes it, and emits plan JSON against `src/lib/plan-schema.ts`. BYO-plan (the athlete iterating a bot-supplied prompt in their own Claude/ChatGPT and pasting JSON back) is **deferred, not removed** — it returns later as an optional path, never the default. This reverses the v0.3 "no server-side plan-generation pipeline" anti-goal, by design. Until templates ship, the built reality is still BYO (see §1). Design + sequencing: `Specs/ONBOARDING_V2.md` (W3).
- **Strava required.** `activity:read_all` OAuth is mandatory. There is no manual log fallback in v1. A broken Strava connection means the agent runs without fresh data and surfaces the gap explicitly.
- **`job_queue` table + Fly.io worker (v0.7).** Background jobs use a Postgres `job_queue` table. The Vercel cron _enqueues_ due jobs; the **Fly.io worker container drains** them with `FOR UPDATE SKIP LOCKED` and runs the agent. No Inngest in v1. (Before v0.7 the cron itself ran the agent in a serverless function — that's retired; the Agent SDK's native binary can't fit a Vercel function.)
- **Agent runtime = Claude Agent SDK + built-in tools, in the worker container (v0.7).** The coaching agent runs `query()` with the SDK's built-in Read/Write/Edit/Glob/Grep/WebSearch tools against a per-athlete working directory hydrated from `memory_files`. **Bash is denied** (`worker/isolation.ts`); Strava is pre-fetched into the folder (`strava_recent.json`) so the agent never needs it. No custom MCP tool catalog, no hand-rolled loop, no `memory-io` layer. Multi-tenant isolation (per-athlete `cwd`, Bash denied, deny-by-default) is a launch gate.
- **Prepaid pay-per-usage from ~20 users (v0.7).** Free for the first ~20 friends; after that an athlete pre-loads credit drawn down by usage. `agent_runs` is the cost ledger; a new `athlete_credits` balance is decremented per run. At $0: finish the in-flight run, then block until top-up.
- **No Supabase Auth magic-link.** Identity is `telegram_chat_id` ↔ `athlete_id`. The web app reads athlete identity from a session cookie set after Telegram linking. The `/signup` page validates against `friend_allowlist` and mints a one-time `link_token`; non-allowlisted emails are captured in a `waitlist` table (v0.7.17).
- **No shadow-bcc (removed v0.7.3).** Outbound coaching messages are no longer mirrored to David's Telegram. There is no 3-day human-in-the-loop approval flow either. David reviews outbound messages via the `messages` table / admin console. The `athletes.shadow_bcc_until` and `messages.mirrored_to_admin` columns remain in the schema but are unused. (`DAVID_TELEGRAM_CHAT_ID` is still used for onboarding alerts via `src/server/admin/alerts.ts`.) See SPEC v0.7.3 change-log.
- **Conversational coaching on; wellness battery is `/checkin`-only.** The agent engages — it may ask subjective/clarifying questions and end a turn on an open question (the answer comes back as the next message → next run). The morning check-in is a **single** message: a coaching/training message grounded in recent data, free to end on a question. The wellness battery — **2 prompts only: readiness 1–10, soreness 1–10 + optional body-part tag** (no free-text note) — is triggered **only** by the `/checkin` command; the proactive morning send is deferred. See SPEC v0.7.2 change-log (supersedes the v0.7.1 two-message shape).
- **Sunday weekly survey off in v1.** The `weekly_survey_log.md` memory file exists in the schema but stays empty. The Sunday survey, plan-change-proposal 👍/👎 flow, and `memory_file_revisions` audit table are all deferred to v1.5.

---

## 5. Anti-goals — refuse if asked

Do not implement any of the following without a spec update and explicit instruction:

- **Inngest** or any other durable-job infrastructure. The `job_queue` table is the job queue.
- **Manual log fallback** for athletes without Strava.
- **Supabase Auth magic-link** or any email-based auth flow for athletes. `telegram_chat_id` is the durable identity.
- **Garmin scraping.** Garmin has no usable public API; do not implement scraping.
- **Web onboarding routes** (`/onboarding/*` or equivalent). Onboarding is Telegram-only.
- **`memory_file_revisions` table.** Per-write audit trail is covered by `agent_run_steps`.
- **Marketing landing page or component library** beyond plain Tailwind. The web surface is intentionally minimalist.

---

## 6. File-structure conventions

```
src/
  app/                  Next.js App Router pages and API routes
  lib/                  Shared utilities and type definitions
  server/
    telegram/           Bot webhook handler, outbound send helper, onboarding state machine
    strava/             OAuth, token refresh, recent-activity fetch (ephemeral — never persisted), disconnect/deauthorization helper
    agent/              Onboarding LLM helpers (byo-plan, race-lookup, plan-validator). NOT the coaching agent (v0.7).
  components/           React components (Tailwind only — no component library)
worker/                 (v0.7) Fly.io worker container: Agent SDK loop over per-athlete folders, job_queue drainer
supabase/
  migrations/           Numbered SQL migration files
scripts/                One-off scripts (seed, smoke tests, manual plan-gen)
Specs/                  SPEC.md and any future spec documents
```

> v0.7 note: the daily/ad-hoc coaching loop and the memory read/write layer that used to live in `src/server/agent/` are retired. The coaching agent now runs in `worker/` via the Agent SDK's built-in tools. `src/server/agent/` keeps only the onboarding-time LLM utilities. Exact `worker/` layout is defined in `Specs/M1_IMPLEMENTATION_PLAN.md`.

---

## 7. Commands

```bash
# Build
npm run build

# Lint
npm run lint

# Type check
npm run typecheck

# Format (write + check)
npm run format
npm run format:check

# Test
npm run test

# Reset local database (requires supabase start)
npm run db:reset

# Generate TS types from local schema (requires supabase start)
npm run db:types

# Smoke test — verifies Supabase connection (requires supabase start + .env.local)
npm run db:smoke

# Health check (/api/health green check)
curl -sS https://hammytime.vercel.app/api/health | jq

# Start the bot in polling mode (local dev, no ngrok — requires TELEGRAM_BOT_MODE=polling in .env.local)
npm run bot:dev

# Start everything: Supabase, Next.js dev server, and polling bot in parallel
npm run dev:all

# Onboarding test loop (runs against PROD via .env.local — see docs/testing-onboarding.md first)
npm run test:reset -- <email>        # wipe the test athlete back to pre-onboarding (group-chat-only, guarded)
npm run token:mint -- <email> [ttl]  # mint a start token; prints a paste-ready /start@<bot> <token> for the group
```

> Re-testing onboarding without touching the real account: the test athlete onboards in a Telegram **group** (negative `chat_id`) via a staging bot pointed at the same prod DB. Full runbook — one-time setup + per-run loop — in `docs/testing-onboarding.md`. `test:reset` refuses any non-group (positive-id) athlete, so it can't touch the real one.

---

## 8. Session status

`claude-status.md` in the repo root is the running project snapshot. It records: where we are, what has been done, what is left, the end goal, important milestones, deferred problems, and the likely next task. It is a **snapshot, not a log** — older session-by-session history lives in `Specs/archive/session-log.md` and git, not here.

- Read `claude-status.md` at the start of every session to orient yourself.
- Update it at the end of every session — even if the only change is marking a task complete or adding a new deferred item.
- Keep it a snapshot. Add a brief entry under "Last sessions" at the top, and when you do, move the oldest of the inline sessions (keep ~2) into `Specs/archive/session-log.md`. Refresh "Current status" and "Likely next task" to present reality rather than appending another dated block — do not let this file grow back into an append-only log.
- If a session ends with open threads, capture them in the "deferred / open questions" section rather than leaving them in conversation context.

---

## 9. Working agreement

Each prompt is a scoped unit of work defined by the deliverable stated in that prompt.

- If you are tempted to do something outside the stated deliverable, stop and ask before doing it.
- Do not silently expand scope.
- Do not add libraries that are not named in the deliverable.
- Do not refactor surrounding code unless the deliverable explicitly asks for it.
- Do not add error handling, fallbacks, or validation for scenarios outside the deliverable's stated scope.
- Before starting any non-trivial task, re-read the relevant section of `Specs/SPEC.md` to confirm your understanding matches the spec.

---

## 10. Git & deploy discipline

This is a low-stakes, friends-only repo, worked directly on `main` (no PR flow), and David often runs 2–3 Claude Code sessions at once against the same checkout. The rules below keep that safe without heavyweight process.

### Two surfaces deploy two different ways

- **Web (Vercel)** auto-deploys on **push to `main`**. The push *is* the web deploy.
- **Worker (Fly)** deploys only via **`fly deploy`**, which **builds from the local working tree, not git** — it bundles whatever is on disk right now, committed or not.

Match the action to what changed:
- Worker-only change → `commit → push → fly deploy`.
- Web-only change → `commit → push` (no `fly deploy`).
- Both → `commit → push → fly deploy`.

### Commit and push, always, together

Commit and push in one motion, every time, as soon as a unit of work is done and green. **Never leave a commit unpushed.** David doesn't test locally — prod is the test environment — so holding a push buys nothing and only hides work from his other sessions and the remote. Don't batch up local commits.

### Before any `fly deploy` or push: confirm the tree is just your change

Because Fly ships the local tree and other sessions may be editing it, run `git status` first and proceed only if the working tree contains **only** the change you're shipping. If files appear that aren't yours, **stop and flag it** — another session is likely mid-flight. Commit (and push) before you `fly deploy`, never deploy first and commit after.

If two sessions repeatedly collide on the same files, that's the signal to move to a worktree or separate clone per session — raise it rather than pushing through.
