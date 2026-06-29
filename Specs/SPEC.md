# Marathon Coach — Productized Spec

**Author:** dtemple
**Date:** 2026-05-18 (v0.3); 2026-05-07 (v0.1)
**Status:** draft v0.7
**Constraints baked in:** friends-only audience (~5–25 at launch), solo founder full-time, free for the first ~20 friends then prepaid pay-per-usage, 4–6 week launch, advice quality non-negotiable.

This doc covers: sequencing + rough costing, technical implementation plan, open questions, technical risks, business risks. Built off the existing personal coach in this repo (`marathon_training_plan.json` + five memory files + Strava/Garmin/Claude agent loop).

### Change log

> Full change history (v0.1 → current) is in `Specs/CHANGELOG.md`, which is **part of the spec's source of truth** — several entries there are authoritative for an in-flight feature until its §3.x body is rewritten. Only the most recent entry is kept inline below.

- **v0.7.20 (2026-06-04) — onboarding v3 approved: slot-filling conversational intake (replaces v2's button state machine). Designed, not yet built.**
  - Watching real athletes onboard exposed v2's failure modes (`transcripts/bmulderr_gmail.com.md`): typed answers rejected on button screens ("Yep!" failing race-confirm), no cross-question awareness so over-answered facts get re-asked, and a brittle Haiku enrichment parse that looped four times on a marathon time goal ("10 minute miles" → 1:40:00 → 7:20:00 → 0:04:25 → 4:25:00). The flow read as a form, not a coach. Full design + execution plan: `Specs/ONBOARDING_V3.md`; **this entry is the authoritative record until the build lands and the §3.9 body is rewritten** (same convention as v0.7.8 → v0.7.10/v0.7.12).
  - **Slot-centric, not section-centric.** One global slot schema for the whole intake; every inbound message (text or voice) can fill any slot. The bot asks only for what's unfilled; an already-answered topic collapses to a confirm or is skipped — this kills the cross-question redundancy. Live slot state persists in `onboarding_state.partial` for resumability.
  - **Freeform-first; small answer sets always get chips.** Open slots open with a freeform prompt; any question with ≤3 discrete answers (yes/no/skip, day-of-week) always renders chips, and a tap or the equivalent typed words fill the same slot — typing is never rejected. Reverses v2's button-gate-as-primary.
  - **Model: Sonnet (`claude-sonnet-4-6`), not Haiku.** Free-form parsing, unit/plausibility reasoning, and coaching voice carry the athlete's first impression; the higher per-turn cost is accepted at friend scale. A **deterministic plausibility layer** backstops numeric slots (a "4:25" marathon resolves to hours, not minutes; a pace computes to a finish time); ambiguity → one chip-offered disambiguation, never a silent guess; corrections are field-targeted (no "tell me again" restart). Numeric extraction is the regression to avoid — it's what Haiku flubbed live.
  - **Required + safety always filled; optional on a budget (~8 total), the rest → `known_gaps`.** Injury is the safety beat: free-form "tell me about any past injuries or anything nagging," with `[Nothing right now]` / `[Skip]` chips. **Soft gate, not a hard block** — `[Nothing right now]` = healthy, a described injury fills it, `[Skip]` leaves `injury_status` `unknown` (never "healthy") → conservative plan + early coach follow-up. Silence or skip is never recorded as healthy (code-enforced).
  - **Orientation + ready gate (new).** Before the first question the bot sets expectations (what it'll ask, talk normally / use the mic, it'll pause to think, you can leave and resume) — slower Sonnet turns otherwise read as a broken bot; a "typing…" indicator covers each pause. The gate is soft: an over-answerer's first message is parsed, not discarded.
  - **`/edit_profile` menu (replaces a `/resume` command).** A persistent menu forks into **Update something** (add/overwrite info, confirmed inline) and **Finish my profile** (the bot walks the athlete's open `known_gaps`) — a user-initiated complement to the daily coach's opportunistic gap-fill (v0.7.15). Works during and after onboarding.
  - **No-race / general fitness routed in, not blocked (Option 1).** A freeform "just want to get fit, no race" routes into `keep_fit` (the `base-maintenance` template, already rendering), **retiring v2's "day-to-day — coming soon" wall** — a soft flow can't reliably gate intent, and gating re-creates the "answer rejected" experience v3 removes. One boundary stays: broad non-running fitness gets an honest "I'm a running coach" rather than a forced base plan. The **non-race `coach.md` branch is in v3 scope** (V3-W7) so a no-race athlete's *daily* coaching isn't race-framed; the up-front soft expectation-setting message is deferred (out of scope).
  - **Enrichment dump removed.** The conversation subsumes it; a final summary recap before plan-gen replaces the standalone echo-confirm. `seedKnownGaps` still runs at completion.
  - **Eval harness is a launch gate.** Determinism moves behind a model, so a fixture set (chatty over-answerer, terse, voice-disfluent, adversarial, cold-start, no-race, injured, injury-skipper, messy-time-goal, safety-contradiction) asserts the invariants: injury always asked and never healthy-from-skip, no `generate` with a required slot open, over-answers not re-asked, numeric disambiguation correct, field-targeted corrections, contradictions surfaced. (Distinct from the v0.7.19 coaching-message eval — this one gates the *intake*.)
  - **Prerequisite (do first) — log button taps.** `handleOnboardingCallback` never writes an inbound `messages` row, so selections are invisible and transcripts read as bot monologue; fixing it (V3-W0) unblocks both human review and the eval harness, and improves the live v2 flow immediately.
  - **Out of scope but named dependencies:** the template renderer placed Brenden's race a week early (a `src/lib/plan-templates/` bug — must-fix, since a broken plan undoes a good intake); and the worker coach narrated its reasoning and edited the plan mid-onboarding — v3 defines the onboarding→worker handoff so plan correctness never depends on the worker, but the leak itself is a `worker/prompts/coach.md` change.
  - **Cutover:** v3 ships as the **default**; a feature flag is kept only as a fast fallback to v2 during rollout, not a long-lived A/B. **Locks unchanged:** onboarding stays Telegram-only, Strava required, plan-gen template-first. **No anti-goal reopened** — extraction stays inline in the bot path (as enrichment is today); no durable-job infra, no web onboarding, no manual-log fallback. Supersedes `ONBOARDING_V2.md`'s flow shape (Phase-A beats + the Phase-C dump).

---

## 1. Product shape (what we're actually building)

A multi-tenant version of the existing coach that any of your runners can sign up for, onboard, and receive Telegram-based daily updates from. The architecture mirrors the personal version closely (v0.7): per-athlete plan-of-record, per-athlete memory **as a folder of files**, the **Claude Agent SDK with its built-in tools** reading Strava signal + daily wellness battery, structured response. The agent runtime runs in a **worker container** (Fly.io), not a Vercel function — see the v0.7 change-log entry and §3.1. The shipped surface is **Telegram** for the daily-loop and conversational coach; the web app is a thin, minimalist signup page + an admin console (David-only). There is no web onboarding flow — onboarding happens in chat with the bot.

**v1 scope (locked, v0.3):**

- Minimalist web signup (allowlisted friend emails → one-time Telegram deeplink). No web onboarding flow.
- **Telegram-conversational onboarding**: bot walks the athlete through goals, races, injury history, recent mileage, free-text "anything else." Writes through to memory files as it goes.
- **BYO-plan generation**: after onboarding, the bot sends the athlete a prompt template with their answers pre-filled. They paste it into Claude or ChatGPT, iterate until the plan feels right, and paste the resulting plan JSON back to the bot. Server validates against schema and persists as `plan_versions` v1. No server-side plan generation in v1.
- **Strava OAuth required.** No manual log fallback in v1.
- Telegram bot for daily updates + ad-hoc check-ins (the actual product surface).
- Adaptive daily-prescription modifications driven by Strava signal + daily wellness battery. The plan itself stays static between versions; only the daily prescription bends.
- Injury-aware prehab prescriptions.
- Daily wellness battery — 2 prompts: readiness 1–10, soreness 1–10 (+ optional body-part tag). On-demand via the `/checkin` command in v1; the proactive morning send is deferred (see v0.7.2 change-log). (Reduced from the 3–4 item sketch in §8.6 — see v0.7.1 change-log.) **(v0.7.52: `/checkin` removed — the battery now has no trigger; code retained.)**
- ~~"Shadow bcc" — every outbound bot message also delivered to David's personal Telegram for the first 7 days per athlete.~~ **Removed (v0.7.3):** created duplicate-message noise; outbound messages are already in the `messages` table for David to review.

**v1 explicitly out of scope (defer):**

- Server-side plan generation pipeline (deferred — BYO-plan covers v1, automated pipeline is v1.5+ once we've seen what plans friends actually paste back).
- Manual log fallback for non-Strava users.
- ~~Payments / billing.~~ **Pulled into scope at ~20 users (v0.7):** prepaid pay-per-usage. Free for the first ~20 friends; after that an athlete pre-loads credit that draws down by usage. See §3.11.
- Garmin biometrics — confirmed dropped per §8.5 (no usable public API).
- Mobile app (Telegram is the mobile surface).
- Web onboarding UI (Telegram is the onboarding surface).
- Multi-coach / coach marketplace.
- Group features, leaderboards, social.
- Race-day live tracking.
- Apple Health / Polar / COROS integrations (per §8.6, revisit in v1.5).
- iMessage / WhatsApp / SMS channels.
- Inngest or other durable-job infra — Vercel cron + a queue table is enough at 25-athlete scale.
- Sunday weekly-survey, plan-change-proposal 👍/👎 flow, memory_file_revisions audit table, web search domain allowlist — deferred to v1.5 unless a real need surfaces during alpha.

---

## 2. Sequencing & rough costing

Six-week plan, solo full-time, with a one-week buffer at the end. Build costs assume your time is the dominant input — the dollar figures are out-of-pocket spend only.

### Week 0 — Setup (2–3 days)

**Exit criteria:** `/api/health` returns 200 with green pings for Postgres, Anthropic, Telegram (`getMe`), and Strava (`/oauth/authorize` HEAD).

**Day 0.1 — Decisions and reading.**

- Lock the scope cuts from §1 and the change log above.
- Read Strava's API ToS and Brand Guidelines end-to-end. This is the biggest blind spot in the plan per §5.3 / §7 — if Strava's terms forbid AI-driven coaching at the level we want, the rest of the spec changes.
- Decide name (or defer; Vercel default URL is fine for v1).
- Confirm stack: Next.js 15 + Supabase + Vercel cron + `grammy` for the Telegram bot. No Inngest.
- Write down the kill criterion (§6.10) — e.g. "if fewer than 40% of alpha friends are still actively replying to daily check-ins at week 8, sunset and take the learnings." Hard to write honestly once you're invested.

**Day 0.2 — Accounts and keys.**

- Provision: Vercel project, Supabase project, Anthropic API key, Strava API app (client id + secret + webhook callback URL), BotFather bot + token, Sentry project, Resend project (smoke-test only in week 0).
- Extract reusable parts from the personal `CLAUDE.md` and `marathon_training_plan.json` into a `prompts/` dir in the new repo. Pull out the generalizable patterns (look-it-up-first protocol, memory write-through, wellness battery wording, prehab tiers); leave David-specific bits behind.
- Draft v0 of the BYO-plan prompt template that the bot will hand to athletes. This is a real artifact — see §3.4. Spike it now against your own onboarding answers in Claude to make sure the output JSON is close to the existing `marathon_training_plan.json` shape.

**Day 0.3 — Scaffold.**

- `create-next-app` with TS, App Router, Tailwind.
- Supabase client + env wired (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, service-role key in Vercel only).
- Sentry wired (server + client + edge).
- `/api/health` endpoint that pings Postgres, Anthropic (cheap Haiku call), Telegram (`getMe`), and Strava (HEAD on `/oauth/authorize`). Returns a status JSON. This is your one-shot smoke test for the rest of the project — wire it before any feature work.

**Out-of-pocket:** ~$0 (free tiers cover everything).

### Week 1 — Data model, allowlist, Telegram-onboarding

**Exit criteria:** a friend can be added to `friend_allowlist`, click a one-time link, link Telegram, complete the full onboarding conversation in chat in under 10 minutes, and end up with a populated `athletes` row + memory files + a `plan_versions` row with `status = awaiting_paste`. David receives a Telegram alert when a new athlete reaches the awaiting-paste state.

**Day 1.1 — Data model + migrations.**
Migrations for the v1 schema. Trimmed from §3.3 — drop `memory_file_revisions` (cut #7) and `invites` (cut #14 → `friend_allowlist` instead):

```
users, athletes, races, injuries,
plans, plan_versions (status: awaiting_paste | active | superseded),
memory_files (no revisions table),
oauth_tokens, activities,
messages, agent_runs, agent_run_steps,
friend_allowlist, job_queue
```

Row-level security on athlete-scoped tables. Seed yourself as athlete 1 manually for early-week dev.

**Day 1.2 — Allowlist signup + Telegram link handshake.**

- `friend_allowlist` table; you add rows by hand for v1 (cut #14).
- `/signup?email=...` page: validates against allowlist, mints a one-time `link_token` (15-min TTL, single-use), renders a `tg://resolve?domain=<bot>&start=<token>` deeplink + a QR code for desktop visitors. Non-allowlisted emails branch to a **waitlist** request instead of dead-ending (v0.7.17).
- The page matches the Daybreak landing look & feel via the shared `SiteShell` chrome (v0.7.17 — supersedes the original "visually minimalist, three-line value prop" direction). Still no marketing scroll; the card holds eyebrow + headline + lede + form.
- Optional: Resend "here's your link" email path, only if the friend prefers email over web. Smoke-test only; don't build the whole flow.

**Day 1.3 — Telegram bot scaffold.**

- Webhook receiver at `/api/tg/webhook` with HMAC-style secret-token verification (Telegram's built-in `secret_token` header).
- Inbound: parse update, persist a `messages` row, ack within 200 ms.
- Outbound send helper with 4096-char chunking and a markdown subset (MarkdownV2 is strict — escape liberally).
- `/start <link_token>` handler resolves the token → links `telegram_chat_id` to `athlete_id` → sends a fixed welcome message and kicks off onboarding step 0.
- Smoke-test inbound + outbound by chatting with the bot yourself.

**Day 1.4 — Onboarding-via-Telegram state machine (the meat of week 1).**
Conversational onboarding with state stored in `athletes.onboarding_state` jsonb (current step, partial answers). The bot drives one question at a time and parses replies into structured fields. Steps:

- **Step 0** — name, age, sex, timezone, training availability (days/week, hours/week comfortable with).
- **Step 1** — primary distance, finish-vs-time, freeform "what running means to you" (used for tone, written verbatim into `athlete_profile.md`).
- **Step 2** — goal race (date, name, distance, elevation, terrain), tune-up races (multi-add), past notable race for PR baseline. The bot looks up race details via WebFetch when the athlete names a race, per the look-it-up-first protocol.
- **Step 3** — injury history. Use an inline-keyboard checkbox-ish picker (Telegram inline buttons toggling state); for each selected body part, follow up with severity + currently active? + free-text notes.
- **Step 4** — free text "anything else" (asthma, schedule, gear, prior coaching) — written verbatim into `athlete_profile.md`.
- **Step 5** — cold-start fix (cut #9): recent mileage self-report — last 4 weeks average weekly mileage + longest recent run. Needed because we skipped Strava backfill on connect.

Each step writes through to memory files as it completes: `athlete_profile.md` (steps 0, 3, 4, 5), `race_calendar.md` (step 2), `personal_records.md` (step 2 past race). Same write-through pattern as today's `CLAUDE.md` mandates.

Final step output: bot creates a `plan_versions` row with `status = awaiting_paste`, then sends the athlete the BYO-plan prompt template (see §3.4) with their answers baked in, plus the JSON schema and a one-paragraph instruction. Bot also fires a Telegram message to David saying "athlete X finished onboarding, awaiting plan paste."

**Day 1.5 — End-to-end self-test.**

- Drop your seeded athlete-1 row. Re-onboard yourself from scratch via the real flow: allowlist → /signup → deeplink → Telegram → onboarding state machine → awaiting-paste.
- Verify: `athletes`, `injuries`, `races`, `memory_files` (3 files) all populated. `plan_versions` row exists with `awaiting_paste`. David-alert fired.
- Fix whatever is ugly in the conversational flow. Budget half a day for tone iteration — a 6-step Telegram conversation can feel either delightful or interminable depending on phrasing, and you'll only know once you've walked through it once.

**Out-of-pocket:** ~$0–5 (a handful of WebFetch calls during onboarding self-test, plus any Claude/ChatGPT cost while you tune the BYO-plan prompt — your own subscription should cover it).

### Week 2 — Strava OAuth + BYO-plan paste-back + plan validator

**Goals:** Athlete finishes onboarding → connects Strava → pastes a plan back → has an active `plan_versions` row that the agent can read.

- **Strava OAuth in Telegram.** Bot sends an "authorize Strava" link (web page that initiates OAuth with `read,activity:read_all` scopes). Callback persists encrypted refresh token, fires a Telegram message back to the athlete confirming connection. No backfill in v1 (cut #9 in §1) — only "since signup" activities.
- **Strava webhook subscription.** App-level subscription (one for the whole bot), routing by `owner_id` → athlete. The handler does deauthorization (the 48h-deletion compliance term) and, since v0.7.18, fires a proactive coaching run on an `activity`/`create` event — see §3.5 / §3.5.1. Nothing is persisted either way; the event is a trigger.
- **Token refresh job.** Vercel cron every 4 hours, refresh any token expiring within 6 hours. Lazy refresh on use as a fallback. Surface failures as a Telegram message to the athlete + an admin alert.
- **BYO-plan paste-back flow.** Athlete pastes JSON plan into Telegram (single long message; Telegram inbound has no 4096-char limit, only outbound). Bot parses, validates against the plan Zod schema, and either: (a) accepts and writes a `plan_versions` row with `status = active`, or (b) replies with structured validation errors and asks the athlete to fix in their Claude/ChatGPT session and re-paste. Athlete can iterate as many times as needed.
- **Schema validator** with helpful errors. Don't return raw Zod errors — translate them: "I'm expecting 22 weeks, you sent 18" / "Week 5 long run is 30 miles which is above the safety cap for finish-marathon plans — was that intentional?" Build this carefully; it's the only quality gate on plan content in v1.
- **Plan view (web)**: a single read-only page at `/app/plan` that renders the active plan from `plan_versions`. Visually minimalist. Athlete is mostly going to see the plan via Telegram daily check-ins anyway.

**Out-of-pocket:** ~$0–5 (BYO-plan means most LLM tokens are spent in the athlete's own Claude/ChatGPT subscription, not ours).

### Week 3 — Daily agent loop + ad-hoc Telegram replies

**Goals:** Daily check-in cron runs for any athlete with `status = active`, generates a structured update, delivers to Telegram. Ad-hoc Telegram replies route through the same agent runtime.

- Job queue: Vercel cron + `job_queue` (no Inngest, per cut #4). The cron fires hourly and _enqueues_ a `daily_checkin` job for each athlete on the tick where it's their local 5 AM (v0.7.38). The **Fly.io worker container** drains the queue with `FOR UPDATE SKIP LOCKED` (v0.7).
- Daily agent run per §3.7: hydrate the athlete's `memory_files` to a per-athlete working directory, run the Agent SDK with built-in tools (it reads the pre-fetched `strava_recent.json` and writes its own files; Bash denied), sync changed files back to `memory_files`, send to Telegram. The agent emits prose directly — no structured-JSON validation step in v0.7 (§3.7).
- Memory file storage: row-per-file in Postgres (`memory_files`) is the source of truth; hydrated to disk per run and synced back after (v0.7 §3.3). Files mirror today's eight-file layout from `CLAUDE.md` (checkin_log, athlete_profile, race_calendar, personal_records, open_questions, wellness_log, injury_log, weekly_survey_log) — though weekly_survey_log stays empty in v1 since Sunday survey is deferred.
- Agent runtime: Claude Agent SDK in the Fly.io worker, using its **built-in tools** (Read, Write, Edit, Glob, Grep, WebSearch — Bash denied) over the athlete's folder — no custom MCP tool catalog (v0.7 §3.1). Strava data is pre-fetched into `strava_recent.json` at hydrate.
- **Daily wellness battery** triggered on-demand via `/checkin`: 2 prompts — readiness 1–10, soreness 1–10 (+ optional body-part tag). No free-text note. The proactive morning send is deferred (see v0.7.2 change-log). (See v0.7.1 change-log; supersedes the §8.6 sketch.) **Update (v0.7.52): `/checkin` is removed — the battery has no trigger in v1 and is unreachable; the code stays in place, revivable. See the v0.7.52 change-log.**
- Ad-hoc reply mode: inbound TG message → enqueue `tg_message_received` → handler routes to the agent in lighter context (last 3 days of activity + Haiku-routed subset of memory). Per-athlete advisory lock prevents collisions with the daily run.

**Out-of-pocket:** ~$10–30 (you running the loop on yourself + one or two test users).

### Week 4 — Self-test + polish

**Goals:** You are a user. The loop runs end-to-end on you for 5+ days. Bugs fixed.

- Telemetry: per-message token counts, agent step traces, error rates → Sentry + the `/admin` console (athletes, recent `agent_runs`, errors, outbound messages — read-only).
- Quality gates: prompt-cache the system prompt + recent memory; tighten response-format validation. (The "shadow bcc" first-week quality-mirror was removed in v0.7.3 — David reviews outbound messages via the `messages` table.)
- UX polish on web: just the `/app/plan` read-only view. No calendar / profile / history pages in v1 (deferred per §3.2).

**Out-of-pocket:** ~$30–60.

### Week 5 — Closed alpha (5–10 friends)

**Goals:** First 5–10 invited friends onboarded, daily updates flowing, weekly debrief with each.

- Allowlist gating (David adds friend emails by hand — no invite codes per cut #14), basic rate limiting, abuse controls (one-bot-per-user, message length caps).
- Weekly 15-min calls with each alpha user — capture feedback in a simple Linear or Notion.
- Hot-fix queue.
- Plan-paste escape hatch: if a friend can't get their LLM to produce a usable plan, David runs plan-gen manually through the personal coach tooling and pastes the JSON in via admin. Track how often this happens — it's the signal for whether we need to build server-side plan-gen in v1.5.

**Out-of-pocket:** ~$50–120 in API costs (see §2.1) + $0–20 domain (defer the domain until alpha if you want).

### Week 6 — Open up to full friend set

**Goals:** All ~25 friends invited, monitoring stable, a clear "what's next" backlog.

- Self-serve invite flow.
- Postmortem doc on what broke + decisions to revisit.

**Out-of-pocket at steady state:** see below.

### 2.1 Steady-state cost estimate (25 active friends)

LLM cost is the dominant variable. Pricing as of May 2026: Opus 4.6 $5/$25 per M tokens, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5. Prompt caching saves 90% on cached input; batch saves 50% but isn't useful for interactive flows.

**Assumptions per athlete per day:**

- 1 daily check-in: ~50k input tokens (system prompt + 5 memory files + 14 days of Strava activity summaries + plan JSON), ~3k output. ~80% of input is cacheable across the day.
- 2–4 ad-hoc Telegram messages: ~10k input, ~500 output each.
- Once-weekly deeper synthesis: ~70k input, ~5k output.

**With Opus 4.6 + prompt caching:**

- Daily check-in: (40k cached × $0.50/M) + (10k fresh × $5/M) + (3k out × $25/M) ≈ $0.02 + $0.05 + $0.075 = **~$0.15/day**
- Ad-hoc messages: ~$0.02 each × 3/day = **~$0.06/day**
- Weekly synthesis amortized: ~$0.20/wk = **~$0.03/day**
- Per athlete per day: **~$0.24** → **~$7.20/mo per athlete**
- 25 athletes: **~$180/mo** in LLM costs.

**With Sonnet 4.6 for daily, Opus only for plan generation + weekly synthesis:**

- Per athlete per day drops to ~**$0.08** → **~$2.40/mo per athlete**
- 25 athletes: **~$60/mo** in LLM costs.

You said advice quality is non-negotiable — I'd recommend the **hybrid**: Opus 4.6 for weekly synthesis and any "injury concern detected" branch; Sonnet 4.6 for routine daily check-ins; Haiku 4.5 for tiny routing decisions. Gives you ~$80–110/mo at full friend scale and preserves Opus for the moments where quality moves the needle. You can A/B Sonnet vs Opus on yourself first to verify the daily-check-in quality bar.

**Note on plan generation costs (v0.3 update):** Plan generation has moved to the athlete's own Claude or ChatGPT session via the BYO-plan flow (see §1, §3.4). Server-side LLM cost for initial plan generation and any regenerations is therefore ~$0 in v1. The athlete pays for those tokens through their existing Claude Pro / ChatGPT Plus subscription. This also removes plan-generation regression risk from our cost model — runaway plan-gen loops can't blow up our bill.

**Other monthly costs:**

| Line item                                                         | Cost          |
| ----------------------------------------------------------------- | ------------- |
| Vercel Pro (recommended for crons + analytics)                    | $20           |
| Fly.io worker container (v0.7 — always-on small machine + volume) | ~$5–25        |
| Supabase Pro (when you exceed free tier — likely month 2+)        | $25           |
| Sentry (free tier)                                                | $0            |
| Resend (3k emails/mo free)                                        | $0            |
| Domain (or defer for v1)                                          | $0–1          |
| Anthropic API (hybrid model, plan-gen $0 under BYO)               | ~$80–110      |
| **Total monthly steady state**                                    | **~$130–180** |

That's well under the "<$200/mo" ceiling I'd quietly check against, and it's a single-line decision to step up Opus usage if quality demands it.

---

## 3. Technical implementation plan

### 3.1 Stack recommendation

**Web app:** Next.js 15 on Vercel. App router, server actions for the auth/onboarding flow.

**Database + auth:** Supabase Postgres. Authentication in v0.3 is light: web-side, `/signup` validates against the email allowlist and mints a one-time `link_token`; the Telegram handshake binds `chat_id` ↔ `athlete_id` as the durable identity. The web app reads athlete identity from a session cookie set after Telegram linking. No magic-link / Supabase Auth flow needed in v1 — onboarding lives in Telegram. Row-level security on `athletes`-scoped tables uses the cookie-derived athlete id (or the David-only admin key).

**Background jobs:** Vercel cron + a `job_queue` table in Postgres. Decided in v0.3 to skip Inngest for v1 (cut #4 in §1) — at 25-athlete scale you don't need durable retries badly enough to justify the infra dependency. In v0.7 the executor moves: the **Vercel cron enqueues** due jobs into `job_queue`; the **Fly.io worker container drains** the queue with `FOR UPDATE SKIP LOCKED` and runs them. Failures get logged and retried with exponential backoff on the next tick. The same queue carries ad-hoc Telegram messages, so daily and ad-hoc runs share one execution path. Scaling past a few hundred athletes = add worker containers behind the same queue.

**Agent runtime (v0.7):** Claude Agent SDK in TypeScript, running in a **long-running Fly.io worker container** — _not_ a Vercel serverless function. The SDK spawns a ~240 MB native binary that can't fit a 250 MB Vercel function; both Anthropic and Vercel document the container as the intended host (see v0.7 change log). Each athlete gets a **working directory** of files; the worker runs `query()` with the SDK's **built-in tools** (Read, Write, Edit, Glob, Grep, WebSearch — Bash is denied; see Isolation) against that directory, exactly like the personal coach runs Claude Code over `~/projects/health-agent`. The system prompt is the personal coach's `CLAUDE.md`, parameterized per athlete (name, goal race, injuries). A read-only exercise corpus (`worker/knowledge/exercises.md`) is copied into the working directory each run to ground exercise advice in vetted cues + canonical links (v0.7.13). Strava data is **pre-fetched** by the worker into `strava_recent.json` in the folder before the run (`worker/folder.ts`, wrapping the existing Strava client), so the agent reads it like any other file and never needs Bash. Each daily run is idempotent on `(athlete_id, YYYY-MM-DD)` via the `job_queue` unique key. **Isolation:** per-athlete `cwd`, a tool allowlist that excludes Bash entirely, and a guard (`worker/isolation.ts`) that denies any file op resolving outside the folder — one athlete's agent must never reach another's folder.

**LLM:** Anthropic API. Server-side plan generation deferred (BYO-plan, §3.4). Sonnet 4.6 for daily check-ins; Opus 4.6 for weekly synthesis and any "injury concern detected" branch; Haiku 4.5 for tiny routing/classification calls (e.g. "is this Telegram message a question, a status update, or a plan paste?"). All with prompt caching enabled on the system prompt and memory files.

**Strava:** OAuth2, refresh tokens encrypted via Supabase Vault or libsodium. Webhook subscription for deauthorization compliance + a proactive coaching trigger on activity-create (v0.7.18 — see §3.5). Token refresh job on a 4-hour cron. No backfill on connect in v1 (deferred — see §3.5); first plan and first ~14 days of check-ins use the step-5 self-reported mileage as cold-start context.

**Telegram:** Direct Bot API via `grammy` (decided in week 0). Webhook → Vercel API route → enqueue handler in `job_queue`. One bot, all users routed by `chat_id` ↔ `athlete_id`.

**Storage (v0.7):** `memory_files` (one row per `(athlete_id, file_name)`, `text` column) is the **durable source of truth**. The agent does not read/write the DB directly during a run — instead the worker **hydrates** the athlete's files to a working directory on disk before the run, the agent reads/writes real files with built-in tools, and the worker **syncs** changed files back to `memory_files` after. This keeps Supabase authoritative and the per-athlete folder portable across hosts. No `memory_file_revisions` table in v1 (cut #7); rely on `agent_run_steps` for the per-write audit trail. If point-in-time replay bites during alpha, add the revisions table — it's a one-migration change.

**Observability:** Sentry for errors. `agent_runs` + `agent_run_steps` tables (see §3.3) store every agent run's prompt + response + token counts for retrospective debugging. A tiny `/admin` dashboard gated to David's email surfaces these.

### 3.2 Information architecture (web)

The web surface is intentionally minimal in v0.3. Onboarding lives in Telegram; the web app is for sign-up, the Strava OAuth handoff, a static plan view, and admin.

```
/                              → tiny landing: 3-line value prop + email field
/signup                        → allowlist check → mint link_token →
                                 render Telegram deeplink + QR
/strava/connect                → official "Connect with Strava" button →
                                 OAuth (linked from Telegram onboarding)
/strava/callback               → OAuth return, persists encrypted token,
                                 redirects to a "go back to Telegram" page
/app/plan                      → read-only view of the active plan_version
                                 for the logged-in athlete
/admin                         → David-only console: athletes, recent
                                 agent_runs, errors, outbound messages
/api/health                    → status pings (Postgres, Anthropic, TG, Strava)
/api/tg/webhook                → Telegram bot webhook receiver
/api/strava/webhook            → Strava webhook receiver (deauthorization + activity-create coaching trigger)
/api/cron/...                  → Vercel cron endpoints
```

Deferred from v0.1: `/onboarding/*` (Telegram-only now), `/app` dashboard, `/app/calendar`, `/app/profile`, `/app/history`. Athletes can see their calendar, profile, and history through the bot itself in v1 ("show me my races", "what did I tell you about my left hamstring?"). Surface as a real web page only if alpha friends ask.

### 3.3 Data model (sketch, v0.3)

```
users                  (id, email, created_at)
athletes               (id, user_id, name, dob, sex, asthma flag, timezone,
                        telegram_chat_id, free-text notes, onboarding_state jsonb,
                        shadow_bcc_until timestamptz)  -- shadow_bcc_until unused since v0.7.3
injuries               (id, athlete_id, body_part, severity, status, notes, started_at)
races                  (id, athlete_id, name, date, distance_mi, elevation_ft,
                        target_type[finish|time], target_time_sec, status)
plans                  (id, athlete_id, goal_race_id, start_date, weeks, current_version_id,
                        baseline_version_id)  -- baseline = original plan of record; current = working plan (v0.7.11)
plan_versions          (id, plan_id, version, plan_json, schema_version,
                        generated_by[athlete_llm|manual|claude_v2],
                        status[awaiting_paste|active|superseded],
                        generated_at, supersedes_id)
memory_files           (id, athlete_id, file_name, content_md, updated_at)
oauth_tokens           (id, athlete_id, provider, access_token_enc, refresh_token_enc,
                        expires_at)
activities             (id, athlete_id, source, source_id, start_at, distance_mi,
                        duration_sec, elevation_ft, avg_hr, type, raw_json)
messages               (id, athlete_id, channel[tg|web], direction[in|out], body,
                        sent_at, related_run_id, mirrored_to_admin bool)  -- mirrored_to_admin unused since v0.7.3
agent_runs             (id, athlete_id, kind[daily|adhoc|weekly|plan_validate], started_at,
                        finished_at, model, input_tokens, output_tokens, cost_usd,
                        result_summary, error)
agent_run_steps        (id, agent_run_id, step_n, kind[tool|llm], tool_name,
                        input_json, output_json, tokens_in, tokens_out)
friend_allowlist       (id, email, added_by, note, created_at)
job_queue              (id, kind, key_unique, payload jsonb, run_after,
                        locked_at, attempts, last_error, completed_at)
```

Removed from v0.1: `memory_file_revisions` (cut #7 — log via `agent_run_steps` instead), `invites` (cut #14 — `friend_allowlist` replaces it). Added: `onboarding_state` and `telegram_chat_id` on `athletes`, `status` + `schema_version` on `plan_versions`, `shadow_bcc_until` on `athletes` (unused since v0.7.3), `mirrored_to_admin` on `messages` (unused since v0.7.3), the `job_queue` table, `baseline_version_id` on `plans` (v0.7.11).

The memory-file structure mirrors today's eight-file layout (`checkin_log.md`, `athlete_profile.md`, `race_calendar.md`, `personal_records.md`, `open_questions.md`, `wellness_log.md`, `injury_log.md`, `weekly_survey_log.md`), plus a ninth file `known_gaps.md` (v0.7.15) — the deferred onboarding fields the daily coach fills opportunistically. The agent reads/writes via tools; the web app reads for display. `weekly_survey_log.md` exists in the schema but stays empty in v1 — Sunday survey is deferred. The read-only exercise corpus (`worker/knowledge/exercises.md`) is also copied into the working directory each run; it is static reference content, not a `memory_files` row, and is never synced back (v0.7.13).

### 3.4 Plan generation pipeline (v0.7.10 — template-first; BYO deferred)

Plan generation is **template-first and deterministic** (signed off 2026-06-01, SPEC v0.7.8; engine built in W3 of `ONBOARDING_V2.md`). A `(distance × experience-tier)` selector picks one of six templates; a deterministic renderer scales it to the athlete's Strava signal and weeks-to-race and emits a `plan-schema.ts`-valid `Plan` — inline on the bot path, no LLM, near-zero token cost, instant. BYO-plan (the athlete iterating a bot-supplied prompt in their own Claude/ChatGPT and pasting JSON back) is **deferred, not removed**; it returns later as an optional path.

**The engine (`src/lib/plan-templates/`, built + unit-tested in W3):**

- **Templates** — `marathon-finish`, `marathon-performance`, `half-foundation`, `half-development`, `short-race` (5k+10k), `base-maintenance`. Each is a declarative `PlanTemplate`: phase skeleton + weights, cutback rule, volume/long-run model, microcycles by run-day count, a workout menu, a strength model, an `agent_guidance` base, and the overlays it supports. The library axis is distance; tier selects the band and feeds the numbers (`templates/*.ts`, `types.ts`).
- **Selector** (`selector.ts`) — `selectTemplateId(distance, tier)` via the `(distance × tier)` table; `timeGoalEligibility` gates pace work (open on performance/development/short-race; permit-but-discourage a some_training first marathon; suppressed on foundation); `computeRenderParams(profile, snapshot, caps, template)` turns the training profile + Strava fitness snapshot into the `RenderParams` (timeline, start/peak volume, long-run anchor + cap, run days, strength count, overlays, injury accommodations).
- **Renderer** (`renderer.ts`) — `renderPlan` runs `allocatePhases → buildWeeks → placeStrength → assemble → applyOverlays → PlanSchema.parse`. Weeks ramp within the caps by construction; the long run progresses under the step/share/ceiling caps; strength sessions layer onto non-run days without consuming run days (bodyweight until `strength_equipment` is filled); overlays (trail / time_goal / injury / open_ended) modify the draft. Three goal states: committed (race date → finite plan), intended-with-date (finite), intended-no-date / keep_fit (open-ended base+build block, peak/taper deferred until a date binds). **Race-day anchoring + the ease-in first week (v0.7.24, authoritative in the change log until this bullet is rewritten):** a committed plan is anchored so its last week is the race week and the race lands on its real date exactly once (`assertRaceDayInvariant` guards it); a mid-week onboarder's week 1 is a safe ease-in floor (rest the elapsed days + the sign-up day, easy warm-ups for the remainder, no long run/quality), with the adaptive shaping of that week owned by the worker coach, not the renderer.
- **Safety caps** (`caps.ts`, `validateSafety`) — values locked W3 (ramp ≤12% or +3 mi; long-run step ≤2 / 3 post-cutback; long run ≤50% of the week, design target 35%; ≥1 easy day between hard days; per-distance long-run ceilings 5k 8 / 10k 10 / half 15 / marathon 22 / keep-fit 14). Caps are **advisory, never refusals**, with two enforcement moments sharing one source of truth: at **generation** the renderer builds in-bounds and `validateSafety` is a bug-catcher; in **conversation** the worker coach prompt (`worker/prompts/coach.md` `{{safety_caps}}` + `system-prompt.ts`, rendered from `caps.ts`) makes the coach **warn with the tradeoff, ask the athlete to confirm, then comply and write it.** The caps also ride in the rendered plan's `agent_guidance.compliance_rules` (`long_run_progression`, `weekly_volume_cap`, `long_run_distance_cap`).
- **Event-conditioning floor (v0.7.48 — counterpart to the caps).** The caps are a **ceiling** (they stop a single change loading too much). The **floor** catches the opposite failure: short-term accommodations (move/cut the long run for a niggle or a busy week) that accumulate, each locally reasonable, until the athlete reaches the start line underprepared and at higher in-race injury risk. The floor is **chat-time only** (it concerns where accumulated edits leave the buildup, which generation can't see): `src/lib/plan-drift.ts` `computeReadiness` reads the **long-run spine** (original peak vs the longest long run still scheduled ahead vs reached so far, build weeks left before the taper, long runs cut) and emits a calibrated verdict — **ON TRACK / WATCH / AT RISK** — into a `# Race readiness` headline at the top of `plan_drift.md` (dated upcoming race only). The coach (`worker/prompts/coach.md` "Protect the goal-race buildup," gated to race modes by `goalBuildupGuidance`) reads it on any change that touches the long run or a key session, and when readiness is gone puts the **fork** to the athlete (hold and adjust the target / move the date / change the goal) instead of accommodating again. **DRAFT thresholds** (peak tolerance 1 mi, "lost" cut ≥3 mi, volume-watch 10%, assumed taper 2 wk; climb rate = the 2 mi/wk long-run cap) — want calibration against real edit history. Limitations: plan-vs-plan (not Strava actuals), no spine for short races (returns null), the "repeated accommodation" trigger is a prompt instruction not a computed counter.

**Built vs. pending.** W3 ends at a tested `selectPlan → renderPlan` producing a valid, safety-checked `Plan`. Wiring it into the onboarding route — calling it after onboarding, showing the **B1 preview** ("here's your starting plan…", `[Looks good]` / `[Adjust it]`), persisting the `plan_versions` row, routing `[Adjust it]` to the worker coach for conversational customization — is **W4**. The worker agent customizes on top of the rendered plan; it never regenerates from scratch on the bot path. Plan stays **append-only by version** (a modification creates a new `plan_versions` row with `supersedes_id`); the agent never edits an existing version, and the structured `plan_change_proposal` 👍/👎 flow stays deferred (cut #11).

**BYO-plan (deferred fallback).** The v0.3 flow — bot renders a prompt template with the athlete's answers + the schema + a few-shot, the athlete iterates in their own LLM and pastes JSON back, the bot validates against the Zod schema and accepts/rejects with human-readable errors — remains available as a later optional path and as the manual escape hatch (David runs plan-gen in the personal coach's tooling for anyone who needs it). It is not the default and not wired in v1. (Onboarding-time LLM utilities for this path still live in `src/server/agent/`: `byo-plan.ts`, `plan-validator.ts`.)

### 3.5 Strava integration

- **OAuth scope:** `read,activity:read_all` (need detail on private activities since trail runners often keep them private).
- **Backfill:** deferred in v1 (cut #9). On connect we pull only "since signup" activities going forward; cold-start context comes from the step-5 self-reported mileage. If alpha friends consistently want their plan referenced against pre-signup history, add a 90-day backfill in v1.5 — it's a half-day change.
- **Webhook (v0.7.4):** one app-level push subscription (`scripts/register-strava-webhook.ts`), callback at `/api/strava/webhook`. The handler has two jobs. **Deauthorization compliance:** Strava's API terms require deleting a user's data within 48h of their revoking access; "deletion" on a deauth event means removing the `oauth_tokens` row (we persist no Strava activity data). On `object_type='athlete'` + `updates.authorized='false'`, the handler resolves `owner_id` → `provider_athlete_id` → athlete, calls `disconnectStrava(id, { revokeOnStrava: false })`, and sends the athlete a Telegram notice. **Activity-create trigger (v0.7.18):** an `activity`/`create` event enqueues a proactive coaching run (see the Option B bullet below); still nothing is persisted — the event is only a trigger. The POST always returns 200 fast (Strava disables subscriptions that error/timeout); Strava does not sign event POSTs. See §3.5.1.
- **Brand-guideline compliance (app-submission launch gate).** Strava's brand guidelines are checked at app review. `/strava/connect` is an interstitial page rendering the official "Connect with Strava" button (unmodified, native 48px) linking to the authorize URL; `/strava/connected` shows the "Powered by Strava" mark, kept less prominent than the page text. Official assets live in `public/strava/`. When the plan view (`/app/plan`) surfaces activity data it will also need the "Powered by Strava" mark plus a "View on Strava" link (exact text, `#FC5200`/bold/underline) on any itemized activity. Treat the button + mark as a gate for submitting the app to Strava.
- **Activity-triggered runs (shipped v0.7.18 — Option B).** Activity-create events enqueue a `tg_message` coaching run via `handleActivityCreate` (`src/server/strava/activity-trigger.ts`): resolve `owner_id` → athlete, guard onboarded/non-test, apply a 60-min cooldown scoped to prior post-activity pushes, enqueue with a `/fresh_update`-style seed. The worker's hydrate re-fetches Strava live, so the agent sees the new activity with no persistence — the event stays a trigger, not a store. **Any** activity type fires it (the event payload omits sport type; gating to runs would cost a `GET /activities/{id}`). The cooldown only suppresses a *repeat* post-activity push within the hour (a backlog-sync burst) — it fires regardless of the morning daily, so the `agent_runs`/credit cost this reopens (the proactive-send concern from v0.7.2) is bounded to ~one push per activity-cluster. Deferred: "short"/custom post-activity copy distinct from the morning note.
- **Rate limits:** 100 requests / 15 min per app, 1000 / day. At 25 athletes and ~1 activity/day each, no concern.
- **Token refresh:** Vercel cron every 4 hours, refresh any token expiring within 6 hours. Lazy refresh on use as fallback. Store last-refresh timestamp. On refresh failure, message the athlete in Telegram + alert David.

### 3.5.1 Disconnect / deauthorization (v0.7.4)

`disconnectStrava(athleteId, { revokeOnStrava })` in `src/server/strava/disconnect.ts` is the single source of truth for severing a Strava connection. The deletion (removing the `oauth_tokens` row for `(athlete_id, provider='strava')`) always happens; Strava-side revocation (`POST /oauth/deauthorize`) is best-effort and gated on `revokeOnStrava`. Three callers:

- **`/disconnect_strava` Telegram command** — athlete-initiated. `revokeOnStrava: true` so our app also drops off the athlete's https://www.strava.com/settings/apps page. Confirms in chat; handles "no connection on file".
- **`/api/strava/webhook` deauth event** — Strava-initiated (athlete revoked on Strava's side). `revokeOnStrava: false` — there is nothing left to revoke. Satisfies the 48h-deletion term.
- **`scripts/disconnect-strava.ts`** — operator tool, refactored to delegate to the helper (`revokeOnStrava: true`).

### 3.6 Telegram integration

- One bot for the whole product. BotFather setup gives you a token.
- Athlete linking: web shows a deeplink `tg://resolve?domain=BotName&start=<one_time_token>`. Athlete taps, bot receives `/start <token>`, server matches token to `athlete_id`, persists `telegram_chat_id`.
- Inbound: webhook → Vercel API route → enqueue a `tg_message_received` job in `job_queue` → cron worker dequeues and runs the handler. Handler routes by athlete state: onboarding (drives the onboarding state machine), awaiting_paste (looks for a plan JSON), active (ad-hoc reply mode through the agent).
- Outbound: agent emits a message; handler sends via Bot API. Long messages chunked at 4096 chars (TG limit). Sent with `parse_mode: 'HTML'`: the message is HTML-escaped and the coach's `[text](slug)` exercise tokens become inline `<a href="source">` links resolved against the corpus (v0.7.13) — first mention per conversation, no raw URLs, unmatched tokens degrade to plain text. (The "shadow bcc" mirror of every outbound message to David was removed in v0.7.3 — see change-log.)
- Daily check-in delivery: a Vercel cron (`0 * * * *`, hourly) enqueues one `daily_checkin` job per onboarded, non-test athlete on the tick where it's 5 AM in that athlete's timezone (v0.7.38 — per-athlete-local; was a single `30 13 * * *` Pacific fire in v0.7.18, itself a generalization of the original single-athlete pick). The Fly worker drains the queue.
- **Onboarding** lives in the Telegram handler: `athletes.onboarding_state` jsonb holds the v3 slot-filling state (a top-level `flow:'v3'` shape — the live slot map, phase, and optional-question budget). Each inbound message runs one Sonnet `extract_and_advance` turn that fills slots and decides the next move, gated by code guardrails. See §3.9 for the flow.

### 3.7 Daily agent loop (per athlete) — v0.7 container model

Runs in the Fly.io worker, which dequeues a `daily_checkin` job for each due athlete (enqueued at their local 5 AM — v0.7.38):

1. **Hydrate:** write the athlete's `memory_files` rows to a per-athlete working directory on disk, plus the parameterized `CLAUDE.md` system prompt, the pre-fetched Strava context (`strava_recent.json`), and the read-only `exercises.md` exercise corpus (both input-only — excluded from sync-back).
2. **Run the Agent SDK** (`query()`) with built-in tools, `cwd` set to that directory. The agent reads its files — including `strava_recent.json`, the worker's pre-fetched last 14 days (+ 7d/28d summaries + marathon prediction) — web-searches as needed, reasons, and writes back to its files, the same loop the personal coach runs locally. Tools are Read/Write/Edit/Glob/Grep/WebSearch; **Bash is denied**, so the agent uses the pre-fetched Strava file rather than spawning a fetch. No custom MCP tools; the SDK's built-ins do the work. `maxTurns` and a per-run cost budget cap the loop.
3. **Sync back:** changed files in the working directory are written back to `memory_files` (atomic per athlete).
4. The agent's final message is the athlete-facing response — and the _only_ morning message. The coach wraps it in `<message>…</message>` (coach.md output contract); the worker extracts that block (`sanitizeCoachReply` in `worker/reply-sanitize.ts`), so any reasoning the model leaves above the tag never ships. When the tags are absent (model non-compliant), a conservative preamble strip is the fallback. Render into Telegram-friendly markdown; send. (See v0.7.39 change-log. The wellness battery no longer follows automatically; and as of v0.7.52 it has no trigger at all (`/checkin` removed) — see the v0.7.2 + v0.7.52 change-logs. The shadow-bcc mirror to David was removed in v0.7.3.)
5. **Persist** `agent_runs` (model, token split incl. cache, cost) + `agent_run_steps` from the SDK message stream. (Prepaid-balance decrement is deferred — see §3.11; a `// TODO(#12)` hook marks the spot.)

**Weekday vs. Sunday (v0.7.48).** A weekday `daily_checkin` is the light note — today and the next 24–48 hours; it deliberately does **not** run a weekly review or zoom out to the race arc. **Sunday** branches to a named **weekly review** the athlete comes to expect (`buildPrompt` keys on the local weekday; coach.md "What a Sunday review looks like"): week behind → big picture → week ahead, ending on a question that sets the week up. The big-picture beat reads the `# Race readiness` headline in `plan_drift.md` (the event-conditioning floor, §3.4) and the full plan — it's the scheduled home for the macro check the weekday notes skip, so the readiness signal is read aloud even on weeks with no plan edit. Daily checkins already run 7 days/week, so this needs no cron change. (This is a coach→athlete review message, distinct from the deferred Sunday **survey** / 👍-👎 plan-change flow, which stays off in v1.)

Idempotency and concurrency are unchanged from prior versions: the `daily_checkin` job is keyed `daily-{athlete_id}-{YYYY-MM-DD}` (unique in `job_queue`), and a per-athlete advisory lock prevents a daily run and an ad-hoc reply from colliding on the same folder/memory rows.

Response-schema validation note: under the SDK-over-files model the agent emits prose directly (as the personal coach does), so the v0.1 "validate structured JSON, retry on invalid" step is relaxed — the system prompt enforces the response shape, and `agent_run_steps` captures the trace for review. Re-introduce hard schema validation only if alpha shows the agent drifting from the format.

Idempotency: each `daily_checkin` job is keyed `daily-{athlete_id}-{YYYY-MM-DD}` and rows in `job_queue` enforce uniqueness on that key. Re-runs are no-ops. Concurrency: a per-athlete advisory lock (`pg_advisory_xact_lock(hashtext('athlete:' || athlete_id))`) prevents the daily-checkin and an ad-hoc reply from colliding on memory writes (§5.8).

### 3.8 Ad-hoc agent loop (Telegram replies)

Same loop, but: no full memory write-back required, smaller context (last 3 days of activity, relevant memory subset selected by Haiku as a "router" first), Sonnet for response. Cost target: ~$0.02 per ad-hoc message.

**On-demand command triggers (v0.7.16).** Beyond free-text replies, two athlete commands trigger an ad-hoc run directly: `/fresh_update` (refresh and send a status update — the run's `hydrate()` re-fetches Strava and reloads memory, so the refresh is implicit) and `/adjust_plan` (open a plan-adjustment conversation; same handoff as the post-onboarding `[Adjust the plan]` next-action, follow-up free text routed through the active-plan reply path). Both guard against stacking runs: if an uncompleted coaching job for the athlete was enqueued in the last ~10 minutes, the command acks that a run is already in flight rather than enqueuing a duplicate (anti-spam / cost). The `/checkin` wellness battery is separate — see §3.7 and the v0.7.2 change-log.

### 3.9 Onboarding (v0.7.23 — Telegram slot-filling conversational intake, Sonnet, Strava-forward, template plan preview)

> **v4 pointer (signed off 2026-06-24, CHANGELOG v0.7.40).** Onboarding v4 narrows intake to **event-scoped** — a single dated effort (a race or a personal adventure with a date). A no-event signup is now **off-ramped into a dormant state** (no `keep_fit` plan), not routed in; the `keep_fit`/`base-maintenance` path is retired (code left in place). The §3.9 body below still describes the v3 no-event routing as current — that half is superseded by `Specs/ONBOARDING_V4.md` + the v0.7.40 change-log entry, which are authoritative until this body is rewritten as the remaining v4 workstreams (W3/W4/W5/W6) land. The v3 slot engine, guardrails, numeric layer, chips, recap, and `/edit_profile` are unchanged by v4.

_v3 (slot-filling, signed off 2026-06-04, shipped 2026-06-05) is the default flow. `ONBOARDING_V3` is a kill-switch back to v2, not an enable-switch — v3 runs unless the var is explicitly `false`/`0`/`off` (an athlete already mid-v3 stays on it regardless). It replaced v2's button state machine; the eval harness (V3-W5) is the one deferred piece. Full design + execution history: `Specs/ONBOARDING_V3.md` and the v0.7.20 / v0.7.23 change-log entries._

Onboarding runs entirely in Telegram as a **slot-filling conversation**, not an ordered question script. One global slot schema (`src/server/telegram/onboarding/slots/`) is filled across the whole intake; every inbound message — typed or voice — can fill any slot, so an over-answerer is never re-asked and an already-covered topic collapses to a one-line confirm or is skipped. Live slot state persists in `athletes.onboarding_state` (a top-level `flow:'v3'` shape), so an athlete can drop off and resume by sending anything. Each turn is one combined Sonnet (`claude-sonnet-4-6`) tool call (`engine/extract_and_advance`) returning a delta of provenance-tagged slot fills + the next move + the message + chips; pure code guardrails (`engine/guardrails.ts`) then dispose — the model proposes, the code enforces the invariants (no `generate` with a required slot open; injury never "healthy" from silence or skip; no inferred write to a safety/plan-driving slot without a confirm; a hard optional-question budget). A deterministic plausibility layer (`engine/numeric.ts`) backstops numeric slots (a "4:25" marathon resolves to hours, not minutes; a stated distance buckets in code, not by model guess). Strava-derived values (name, sex, timezone, fitness snapshot) are stated back for confirmation, never blind-trusted into a safety- or plan-driving field.

The flow, in order:

- **A0 · Link + Strava** — `/start <link_token>` links `telegram_chat_id ↔ athlete_id`; the OAuth callback derives name/sex/timezone + a fitness snapshot and seeds the v3 state.
- **Orientation + ready gate** — before the first question the bot sets expectations (what it'll ask, talk normally / use the mic, it pauses to think, you can leave and resume) — slower Sonnet turns otherwise read as a broken bot. Soft gate: an over-answerer's first message is parsed, not discarded.
- **Opener 1 · Goal + race** — freeform; fills goal type, distance, race name/date (via `lookupRace`, confirmed inline), often experience and target time too. No-race / "just want to get fit" routes into `keep_fit` (the base-maintenance plan), not blocked; broad non-running fitness gets an honest "I'm a running coach." A goal the catalog can't structure (an ultra distance, a non-race adventure) is detected in code and offered the nearest in-catalog structure with consent — the **uncatalogued-goal pocket** (W8) — rather than forced into the nearest bucket; the athlete's real goal is stored for the daily coach.
- **Opener 2 · Training shape** — the Strava snapshot is stated back ("~4×/week, long runs Sunday, ~30 mi/wk — that right?") to fill experience tier, days/week, and long-run day by confirmation, not cold questions.
- **Opener 3 · Injuries** — the safety beat, always asked: freeform with `[Nothing right now]` / `[Skip]` chips. Soft gate — `[Nothing right now]` = healthy, a described injury fills it, `[Skip]` leaves `injury_status` `unknown` (never "healthy", code-enforced) → a conservative plan + an early coach follow-up.
- **Recap** — the full picture (goal, experience, schedule, injuries, any optional context) echoed before plan-gen; the second catch after the inline confirms on safety/plan-driving slots.
- **Plan preview + next actions** — render + persist the template plan (§3.4) and show it; `[Add to calendar]` / `[Adjust the plan]` / `[That's it for today]`. `[Adjust]` hands the just-generated plan to the worker coach (the coach edits the working version, baseline preserved; §3.4 v0.7.11 drift model).

Chips and typed text are interchangeable everywhere — a tap or the equivalent words fill the same slot, and any question with ≤3 discrete answers always renders chips (typing is never rejected). The policy for when a chip earns its place — and the deterministic eval chip-linter that enforces it — lives in `Specs/ONBOARDING_CHIPS.md` (signed off 2026-06-29), the durable, version-independent source of truth for chips. Required + safety slots are always filled; optional context (age, target time, tune-ups, schedule) runs on a budget (~8 questions), and whatever's left seeds a `known_gaps.md` memory file the daily coach fills opportunistically (v0.7.15). The standalone enrichment dump is gone — the conversation subsumes it, and the recap replaces the echo-confirm. A persistent `/edit_profile` menu forks into **Update something** (add/overwrite, confirmed inline) and **Finish my profile** (the bot walks the open known-gaps), working both during and after onboarding.

Three goal states are modeled: **committed race** (named + dated, taper countdown), **intended** (distance + rough timeframe, taper deferred until a real race binds), and **keep_fit / no-race** (open-ended rolling base — the non-race `coach.md` branch (W7) keeps the daily coaching consistency-framed, not race-framed). A `races` row is written for a committed race; `athlete_training_profile` carries the goal state.

(The retired v0.3 path — a ~15-question deterministic script ending in a BYO-plan paste — is gone from the live flow; BYO onboarding-time utilities remain on disk as the deferred fallback per §3.4. v2's button state machine is superseded but its plumbing — Strava-forward derivation, `lookupRace`, template plan-gen, the `known_gaps` mechanism, voice, the plan-preview hook — is reused by v3.)

### 3.10 Migration path for the existing personal coach

Your own coach in this repo becomes "athlete 1" in the new system. Two phases under v0.3:

- **Week 1 (dev self-test):** seed yourself as athlete 1 manually for early-week dev; re-onboard from scratch on day 1.5 via the real allowlist → /signup → Telegram flow to validate end-to-end. Memory files start fresh.
- **Week 4 (full migration):** ingest your current production memory files (`checkin_log.md`, etc. from this repo) into the DB, replacing the day-1.5 seed data. Point your real Telegram at the production bot. Retire the local Claude Code loop. From week 4 onwards you're a real user, eating your own daily check-ins, which is the single best self-test before alpha.

### 3.11 Billing & metering (v0.7)

Free for the first ~20 friends, then **prepaid pay-per-usage**.

**Design locked 2026-06-04 → see `Specs/METERING_PAYMENTS.md` for the authoritative metering + payment plan.** That doc is the source of truth for credits, draw-down, the Stripe Checkout flow, auto-reload, the $0 gate, warnings, the `/balance`, `/buy`, and `/pause`/`/resume` commands, and the comp flag. **Note: `/pause` adds a paused-athlete skip to the daily enqueue (§3.5/§3.7) — see METERING_PAYMENTS.md §10.** The summary below is a pointer; the doc governs on any conflict.

**Posture: tracking built, balance/gate now specified, build sequenced behind the worker.** Cost is recorded richly today (ledger + rollups, below). The prepaid balance, per-run decrement, and $0 gate were deferred while we were well under 20 users; their design is now decided (METERING_PAYMENTS.md §4–§5) and ready to build as the friend set approaches ~20.

- **Ledger (built):** `agent_runs` records `model`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and `cost_usd` per run. The SDK returns usage and `total_cost_usd` on its result message; the worker writes those straight through. The cache-token split matters: once the system prompt + memory files are prompt-cached, cache reads (~10× cheaper) dominate input volume, and without the split, summed tokens won't reconcile with `cost_usd`.
- **Rollup views (built):** `athlete_cost_daily` (per athlete per athlete-local day) and `athlete_cost_rollup` (cumulative + trailing 7d/28d runs and cost). These feed the burn-rate calc behind warnings, `/balance`, and the runway estimate.
- **Credits + draw-down (designed — METERING_PAYMENTS.md §4–§5):** `athlete_credits` (cents balance, comp flag, auto-reload + saved-card fields) plus an append-only `credit_ledger`. Each run debits `cost_usd × 1.5`. $5 granted once per new friend. At $0: finish the in-flight run, then refuse new runs at dequeue with a top-up message. Fills the `// TODO(#12)` hook in `worker/run-agent.ts`.
- **Payments (designed — METERING_PAYMENTS.md §3, §6, §7):** **Stripe Checkout via a bot-sent link** ($10/$25/$50, default $25), not Telegram Stars — Stars force digital goods onto a 30–50% cut that exceeds the buffer. Opt-in auto-reload (off by default; charges $25 when balance < $3 off-session). The 1.5× buffer is disclosed as cost-recovery, not profit.

Decisions that aren't blocking week 0 but need to be answered by week 2–3. Several from v0.1 have been resolved in v0.2 (§8) or v0.3 — those are marked **[resolved]** with the resolution inline.

1. **Plan schema lock-in.** Today's `marathon_training_plan.json` is bespoke. Do we lock that exact shape and force the BYO-plan output to match, or evolve a v2 schema that better supports plan-version diffs and partial modifications? Recommendation: lock v1 to the existing schema, defer schema evolution.
2. **How adaptive is the plan?** Two ends of a spectrum: (a) full plan rewrite when something changes, (b) plan stays static, only daily prescription bends. The current personal coach is closer to (b). For v1 I'd hold the line at (b) — simpler, more legible to the athlete, less hallucination surface — and note (a) as a v2 axis.
3. **[resolved v0.2/v0.3]** Garmin-style biometrics — Garmin dropped (§8.5, no usable public API). Daily wellness battery (readiness + soreness + body part + optional note) is the v1 substitute per §8.6.
4. **Coach voice / tone.** The current coach has a specific voice ("look it up before asking", terse, sourced). Do we expose tone as a setting? Recommendation: not in v1 — pick one voice, ship it. Iterate based on alpha feedback.
5. **What does "missed a run" actually mean?** Today's logic is informal. Need a concrete rule: if the planned activity day passes without a matching Strava activity by 11 PM local, flag as missed. Define "matching": same day, distance within ±25%, type = run. Edge case: rest days, cross-training days.
6. **Multiple races / season planning.** Current plan assumes one goal race. What if a friend has Boston in April + UTMB-CCC in August? v1 recommendation: support exactly one goal race + N tune-up races; if someone has two goals, build the plan for the closer one and warn.
7. **[resolved v0.3]** Plan regeneration policy — BYO-plan means unlimited athlete-side iterations at zero server cost (§3.4). Validator gives structured feedback; athlete re-pastes as many times as needed. Escape hatch (David manually generates) exists for the few who can't get there with their own LLM.
8. **What goes in the Telegram daily message?** The current personal coach generates a long structured response. Telegram daily on phone wants to be ~200–400 chars + a "see more" link to web. Need to design the truncation rule — don't let it become an essay every morning. Listed as next step #4 in §7.
9. **[deferred to v1.5]** Web search allowlist — the personal coach uses web search for race details, weather, training science. In production we should allowlist domains (race websites, NOAA/weather, peer-reviewed-ish running sources) to reduce injection risk. For v1, log every WebFetch call and review during alpha; build the allowlist when there's data to inform it.
10. **Data export / portability.** Do users own their plan + memory? Recommendation: yes, simple "export everything as zip" button — both because it's the right thing and because it lowers commitment friction for friends.
11. **Account deletion.** Hard delete everything within 30 days of request. Worth nailing down before anyone signs up.
12. **What if the agent contradicts itself?** Today's coach has a `consolidate-memory` skill. We need a server-side equivalent — schedule a weekly "memory hygiene" pass per athlete that dedupes, resolves stale follow-ups, and notes contradictions for review.

---

## 5. Technical risks

Ordered by impact-likelihood product, not pure likelihood.

1. **Plan-quality variance / unsafe plans.** Under v0.3's BYO-plan model the risk shape changes: the athlete generates their plan in their own Claude or ChatGPT, then pastes it to us. The model can still produce a plan that's physiologically reckless (back-to-back hard days, a 22-mile long run on a base athlete) or schema-valid but content-unsafe. Mitigations: (a) the schema validator enforces structural safety caps (max long-run mileage vs. recent-mileage step 5 self-report, hard-day spacing rules, acute:chronic ratio across the generated plan, total weekly volume ramp rate) — reject anything outside; (b) you (David) personally eyeball every plan paste-back for the first 20 athletes via an admin-dashboard alert; (c) daily check-in agent applies the same safety rules and refuses to prescribe a plan-day that violates them, suggesting a downgrade instead; (d) the BYO prompt template explicitly anchors on the safety rules, so the athlete's LLM is steered toward acceptable plans up-front.

   Note: legal exposure improves under v0.3 (see §6.1) — the athlete authored their plan with help from an AI assistant of their choosing. The technical safety job is unchanged.

2. **LLM cost blow-up.** A misbehaved loop or prompt regression can 10x cost overnight. Mitigations: hard daily token cap per athlete, alert at 2x normal, kill switch in admin UI.
3. **Strava ToS.** Strava's API agreement restricts coaching apps and certain types of automated advice. Need to read the current ToS before launch — this could be a real constraint, not just a footnote. Likely fine for friends-only with no monetization, but it shapes what's possible commercially.
4. **Strava API reliability + rate limits.** A webhook storm or a future backfill (deferred from v1) can hit limits. Mitigations: respect `X-RateLimit-Usage` headers, exponential backoff, queue webhook handlers through `job_queue`.
5. **Token refresh failures.** A user revokes Strava access, or refresh tokens expire silently. Need a "your Strava connection is broken" flow that messages the athlete in Telegram with a re-auth link. No manual-log fallback in v1 (cut #3) — broken Strava connection means the agent runs without fresh data and surfaces the gap explicitly until reconnected.
6. **Telegram delivery silence.** No read receipts, no real bounce signal. If a user mutes the bot, we keep generating daily responses they never see. Mitigation: **auto-pause on inactivity** — 5 days with no inbound athlete message → pause daily check-ins and send a one-tap resume notice (a static template, not an agent run). No weekly-downgrade tier. Any inbound message or the button resumes. Supersedes the earlier 14-day-downgrade / 30-day-pause sketch. See `METERING_PAYMENTS.md §10.5` (locked 2026-06-12; shipped + armed 2026-06-22, window 10→5).
7. **Memory file growth.** `checkin_log.md` is append-only and grows unbounded. By month 6 a daily cron pushes 50k+ token check-in logs into context. Mitigation: log rotation — keep last 14 days verbatim, summarize older entries via Haiku into a rolling summary file.
8. **Multi-write conflicts.** Two agent runs on the same athlete writing the same memory file (cron + ad-hoc Telegram reply at the same moment). Mitigation: row-level lock per `(athlete_id, file_name)`, queue ad-hoc handlers behind a per-athlete mutex.
9. **Cold-start athletes.** New user with no Strava backfill (cut #9) → first plan and first daily check-ins are blind to history. Mitigation in v0.3: onboarding step 5 collects "last 4 weeks average weekly mileage + longest recent run" as self-report; the BYO-plan prompt template feeds these numbers in as primary context; the first ~14 days of agent check-ins explicitly account for thin-data case until Strava signal accumulates.
10. **Prompt injection via Strava activity titles / descriptions, and via pasted plan JSON.** Strava is user-generated content that lands in the agent's context, and v0.3 adds athlete-pasted plan JSON as a second injection vector. Mitigations: sanitize / clearly delimit all user-supplied content; never let activity content or pasted plan content authorize tool actions; treat pasted plan as data, never as instruction; keep tool-action allowlist narrow.
11. **Agent SDK upgrades / model deprecation.** Anthropic ships model versions; behavior shifts. Mitigation: pin model versions, run a regression set of 10 canned check-ins on every model bump.
12. **No mobile app means UX friction.** Telegram is good but the web view will get used a lot less than expected. Friends who don't already use Telegram drop off. Mitigation: SMS as a fallback channel for Telegram-resistant friends? Or accept the bias.

13. **BYO-plan paste-back UX failure.** The athlete may struggle to get a usable plan out of their LLM, may paste back malformed JSON repeatedly, or may give up partway. Mitigations: (a) ship the BYO prompt template with a strong few-shot example and the literal schema, so the athlete's LLM has every input it needs; (b) validation feedback in human English, not raw Zod errors; (c) escape hatch — the bot offers "want me to ask David to generate a plan for you?" after two failed validation rounds, and David runs it manually through the personal-coach tooling. The escape hatch is a deliberately manual lever to keep us honest about whether real plan-gen automation is needed before we build it.

14. **Onboarding state machine bugs trap a friend mid-flow.** A parser edge case or schema validation error inside `onboarding_state` could leave an athlete unable to advance, with no obvious recovery. Mitigations: David-alert on `onboarding_state` not advancing for 24 hours; a `/restart` slash command that resets the athlete to step 0; admin dashboard exposes raw `onboarding_state` for manual editing.

15. **Multi-tenant isolation in the worker (v0.7 — new, high-priority).** The worker runs the Agent SDK against a per-athlete folder. A bug, or a prompt injection via Strava activity text (§5.10), could try to make one athlete's run read another athlete's folder or exfiltrate secrets in the container's env. This is the central new risk of the container model. Mitigations (built, `worker/isolation.ts`): scope each run to a per-athlete `cwd`; **deny Bash entirely** and allowlist only the in-folder file tools + WebSearch, with a guard that denies any path resolving outside the folder (incl. symlink escapes); keep per-athlete secrets out of the agent subprocess env (`scrubbedEnv` passes only the Anthropic key + PATH/HOME — no Supabase creds, no athlete tokens); never let activity text or file content authorize a tool action. Treat this as a launch gate, not a polish item.

16. **[resolved by v0.7] Agent SDK can't run in a Vercel function.** The SDK's ~240 MB native binary exceeds Vercel's 250 MB function limit. Resolved by moving the agent runtime to a Fly.io worker container (see v0.7 change log + §3.1). The fallback we considered and rejected — a hand-rolled loop on `@anthropic-ai/sdk` — would have lost the built-in-tool improvisation that makes the personal coach work.

---

## 6. Business risks

1. **Liability for injury.** "I followed the AI coach's hill workout and tore my hamstring" is a non-trivial scenario. v0.3's BYO-plan model improves this story: the plan itself was authored by the athlete using an LLM of their own choosing, and we validated structure only. We are the daily-prescription advisor against an athlete-authored plan, not the prescriber of record. Still keep: (a) a clear ToS disclaiming medical/coaching advice, (b) a "consult a doctor" reminder during onboarding for anyone with active injuries, (c) a logged record of every prescription, plan paste, and plan validation outcome so you can reconstruct exactly what happened, (d) the framing in onboarding that they author the plan (with AI help) and we coach against it — make sure this is explicit, not buried. Personally — talk to a lawyer for an hour before opening to non-friends regardless.
2. **Differentiation against incumbents.** Runna, Final Surge, TrainingPeaks AI Coach, Athletica, Humango all exist or are launching. None have nailed the "memory-rich, conversational, injury-aware" niche, but the field is crowded. For friends-only it's irrelevant; before any paid launch, you need a sharper "why this and not Runna" answer.
3. **Free-tier sustainability.** $80–155/mo for 25 friends is fine personally; at 100 friends you're at $400+/mo of personal cost with no revenue. There's a real exit-velocity question — at what point does this stop being a fun project and become a startup decision? Worth pre-deciding the trigger.
4. **Friend-feedback bias.** Friends are nice. They will not tell you the daily messages are mid. Mitigations: explicit ask for blunt feedback, anonymous feedback channel, weekly NPS-style 1-question Telegram poll, look at engagement numbers (replies / read-time-est) not just self-reported satisfaction.
5. **Trust gap vs human coaches.** Coaching is partly a relationship business. AI coach has a credibility ceiling for serious athletes that may not lift just because the advice is good. Reframing: target the runner who currently has no coach, not the runner who would otherwise hire one.
6. **Health-data regulatory exposure.** US: not HIPAA unless you're a covered entity, and you're not. EU: GDPR special category data (health). For friends-only US-based, low risk; for any EU user, you need a data processing agreement, lawful basis (consent), and deletion flows. Recommendation: geofence to US for v1.
7. **Brand risk of a bad autonomous send.** The agent sends messages to people unprompted every morning. One bad message ("you should run a marathon Sunday on this hamstring") in a public-shareable screenshot is the kind of thing that lives forever on Twitter. The v0.3 mitigation — a "shadow bcc" mirroring every outbound message to David's Telegram for the first week per athlete — was removed in v0.7.3 (duplicate-message noise for little payoff). Mitigation now: the schema-validator safety caps from §5.1 stop the most reckless prescriptions before they leave the building, and every outbound message is persisted to the `messages` table for David to review (and the admin console surfaces it) — after-the-fact rather than within-minutes, but at friends-only scale that's an acceptable trade.
8. **Strava platform-dependency.** If Strava changes ToS or revokes API access (it has happened to coaching apps), you have no product. Mitigation: design `activities` ingestion to be source-agnostic from day one — Strava is one provider, not the spine.
9. **Telegram regional / political.** Telegram is banned or restricted in some markets and has political associations some users dislike. For a US-friend audience this is fine; for any broader expansion you'll want SMS/email parity.
10. **Quitting cost.** If you spend 6 weeks shipping this and nobody uses it past month 2, that's a real opportunity cost. Mitigation: define a "kill criteria" now — e.g. "if <40% of alpha friends are still active at week 8, I sunset this and take the learnings."

---

## 7. Recommended next steps

Updated for v0.3 — stack picks are locked, plan-gen pipeline is deferred, the focus is on the things that gate week 0–1.

1. **Read Strava's API ToS and Brand Guidelines end-to-end** (day 0.1). Still the biggest blind spot. If their terms forbid the kind of advice we want to give, the whole spec changes.
2. **Write down the kill criterion** (§6.10) before starting week 1. Suggested form: "if fewer than 40% of alpha friends are still actively replying to daily check-ins at week 8, sunset and take the learnings."
3. **Spike the BYO-plan prompt template** (day 0.2). 2–3 hours: write the template, paste your own onboarding answers into Claude, iterate until the output JSON matches the existing `marathon_training_plan.json` shape closely. The week 2 paste-back flow only works if this prompt is good.
4. **Sketch the Telegram daily message template** (~300 chars) and dry-run it against your own last 5 check-ins from `checkin_log.md`. The personal coach's responses are too long for daily TG — the template is where you encode the truncation rule.
5. **Decide the schema-validator safety caps** in concrete numbers (e.g. max long-run mileage as a function of recent-mileage step 5 self-report, max weekly volume ramp, hard-day spacing rules). This is what protects you when a friend's LLM produces an aggressive plan. Pull the numbers from your existing `agent_guidance.compliance_rules` and the relevant literature. **These caps are the ceiling; the floor (whether accumulated accommodations have left the buildup unable to reach the start line ready) shipped in v0.7.48 as the chat-time `# Race readiness` signal + the coach's "Protect the goal-race buildup" instruction (§3.4). Its DRAFT thresholds want the same calibration pass as the caps once real edit history exists.**

---

## Appendix A — Cost summary card

| Stage                                   | One-time                      | Monthly   |
| --------------------------------------- | ----------------------------- | --------- |
| Build (weeks 0–6, your time aside)      | ~$100–250 in API + $20 domain | —         |
| Steady state, 25 athletes, hybrid model | —                             | ~$125–155 |
| Steady state, 25 athletes, all Opus     | —                             | ~$220–250 |
| Steady state, 100 athletes, hybrid      | —                             | ~$350–450 |

## 8. Follow-up decisions

Three questions raised after the v0.1 review. Each affects scope and product direction.

### 8.1 What if we drop Telegram and go web-only?

**Scope delta is roughly neutral, product delta is meaningfully worse.**

What Telegram is doing in v1:

- Push delivery of the daily check-in (high-attention, ~70–90% open rate in habit-loop apps)
- Conversational ad-hoc Q&A on the device the user is already holding
- Zero install friction (most of your friends already have it; the rest install in 2 min)

What you'd remove if you cut it: BotFather setup, deeplink linking, webhook handler, message chunking, the regional caveat in §6.9. Realistically ~3–4 days of build.

What you'd have to add to keep the daily-update loop working:

- Web push notifications via a PWA. ~3–4 days, plus the iOS Safari complications (web push on iOS only works for installed PWAs and only since 16.4, with reliability issues), so realistically you also need...
- Email fallback for the morning digest. ~1–2 days (Resend + a mjml-ish template).
- A more polished in-app chat UI for ad-hoc Q&A. ~2–3 days.

Net build delta: roughly **+2 days** vs. Telegram, possibly less. So scope-wise it's a wash.

The product delta is where this gets expensive:

- **Daily engagement collapses.** Web push notification opt-in averages 5–15%. Email morning-digest open rates for product comms are 20–30%. Telegram messages from a bot the user opted into sit around 70–90%. The whole product hinges on the morning loop happening; cutting Telegram cuts the floor on that loop in half.
- **Conversational latency goes up.** A user texting their coach back is a five-second action. A user signing into a web app to type a follow-up is a minute-plus action that often doesn't happen.
- **You lose the "feels like a friend" register.** Daily messages from a TG contact named "Coach" read very differently from a notification or an email.

**Two intermediate options worth considering:**

1. **SMS instead of Telegram** via Twilio. Open rate is similar (~95%), works for everyone, no install, costs ~$0.008 per outbound message → ~$2.50/mo per athlete at 10 messages/day. Adds A2P 10DLC US registration friction (~$15 one-time + waiting period). Equivalent build effort to Telegram. The right swap if you suspect your friend group is Telegram-resistant.
2. **Email-first daily digest + web for chat** (no push). Cheapest. Loses the conversational surface — daily updates land, but ad-hoc questions go to web only. Workable if the daily digest is the 80% feature.

**Recommendation:** keep Telegram for v1. If you genuinely don't want to maintain a TG bot, swap to SMS via Twilio rather than going web-only. Web-only is the worst-of-both-worlds option for a daily-loop product.

### 8.2 How well does injury guidance work with Strava-only data?

**Honest answer: roughly 60–70% of what's possible with full biometrics, and the missing 30–40% is mostly early-warning overtraining detection.**

What Strava actually gives you for injury work:

- Per-activity distance, duration, pace splits, elevation, in-activity HR (if the watch captured it), cadence, sometimes power, optional self-reported RPE.
- Activity titles + descriptions (free-text — the agent can mine "calf felt tight" out of Strava notes).
- Aggregate volume across rolling windows.
- Activity type (run / trail run / hike / strength / etc.).

What you can compute well from this alone:

- **Acute:chronic workload ratio (ACWR).** 7-day load divided by 28-day load. >1.5 has reasonable evidence as an injury-risk threshold (Gabbett's work, with caveats). Needs only volume + intensity proxies. Strong, well-validated.
- **Foster training monotony / strain.** Daily session-RPE × duration, then variance across the week. Detects "every day the same hard easy" patterns. Strong.
- **Hill / eccentric load.** Elevation-gain volume in last 7 vs 28 days. Important for your friends running trail. Strong.
- **Pace–HR decoupling.** If HR drifts up >5–10% relative to pace late in long runs, fatigue indicator. Strong if you have HR.
- **Repeat-injury pattern detection.** Correlate past flare-ups (logged in `injuries` + memory files) with the workout shape preceding them — e.g. "every hamstring flare in the last year followed a hill day within 48 hours." Medium, gets stronger over time.
- **Cumulative load on at-risk tissues.** Hamstring tendinopathy correlates with sprint / hill / fast downhill volume — all visible in elevation + pace.

What you can't do well without biometrics:

- **Early-warning overtraining detection (the big one).** Drops in HRV and rises in resting HR show up roughly 7–14 days _before_ injury or illness manifests. This is the single highest-value injury-prevention signal and Strava can't see it.
- **Sleep-driven recovery deficits.** A week of 5-hour sleep is not visible to Strava but cuts adaptation and raises injury risk.
- **Sub-clinical illness onset.** Resting HR is up 8 BPM = oncoming cold = don't push hard. Strava-blind.
- **Day-to-day "ready or not."** Sometimes the legs are great, sometimes they're trash; HRV captures this; Strava doesn't.

**The cheap fix that recovers most of the gap: ask the athlete.** Daily one-tap morning check-in via Telegram with a 1–10 readiness number ("how's your body this morning, 1–10?") plus optional one-line note. Self-reported wellness scales (Hooper, RESTQ-Sport, simple 1–10) are competitive with HRV in published studies for predicting maladaptation, and far cheaper to deploy. With this in place, you recover most of the early-warning band that pure Strava data misses, at zero device cost.

**Recommendation:** add a daily 1–10 readiness check-in to Telegram as a standard part of the morning loop in v1. This is the single highest-ROI v1 addition for injury prevention. Combine with ACWR + hill-load + Foster strain on the activity side, and the agent can credibly do the prevention job for amateur trail runners — not at "$10k Whoop-equipped pro coach" level, but well past "generic plan from a book." For your audience (friends finishing a marathon), this is enough.

### 8.3 Can we get HealthKit / device biometrics to fill the gaps?

**Yes, with real scope cost. There are four practical ingestion paths; pick by athlete device profile.**

Apple HealthKit is the obvious first thought because most of your friends are likely on iPhones. But HealthKit data is on-device-only — it cannot be read by a web app. You need one of:

1. **Native iOS companion app (you build it).** Read HealthKit, POST to your API on a background schedule. Real scope cost: Apple Developer Program ($99/yr), Swift/SwiftUI, HKObserverQuery + background delivery, App Store review (1–3 weeks the first time, faster after), TestFlight for friends. **Realistic add: 2–3 weeks** for a thin app, plus ongoing review/update overhead. Hard to fit in the 4–6 week MVP window.

2. **Third-party HealthKit-export app** (e.g. Health Auto Export, HealthFit). Athlete installs the app once, configures it to POST a JSON payload to your webhook endpoint on a daily schedule. You parse on the server. **Add: ~2–3 days** to build the ingestion endpoint and reconciler. Friction: athlete pays $5–10 one-time, and the apps occasionally break. Workable for friends-only; not at scale.

3. **Garmin Connect for Garmin owners.** Garmin's Health API (Connect IQ) is real but requires a developer agreement and key; it gives daily resting HR, HRV at rest, sleep, stress, body battery. The existing `fetch_garmin.js` in this repo proves the path; productizing means moving auth to OAuth, doing the multi-tenant ingestion server-side, and handling the API's reliability quirks. **Add: ~4–5 days.** Covers any friend on Garmin (probably 30–50% of trail-running friends).

4. **Whoop API.** Official, OAuth, gives the right data. Add ~2 days if you have Whoop users.

A useful tactic: **let the user pick.** Onboarding asks "what do you wear?" and we wire the right ingestion. The agent then reads from a unified `biometrics` table, source-tagged, prioritizing in this order: Whoop > Garmin > HealthKit > Apple Watch via HealthKit > Polar/COROS > nothing. If two sources disagree, pick the higher-frequency one and log the discrepancy.

**Pragmatic v1 plan if you want biometrics in scope:**

- Defer the native iOS app (don't blow the timeline for it).
- Ship the **HealthKit → Health Auto Export → webhook** path for iPhone users. ~3 days.
- Ship the **Garmin Connect** ingestion path. ~4 days. This also lets you migrate yourself off the personal scripts.
- Ship the **daily 1–10 readiness check-in** (from §8.2). ~1 day. Works for everyone regardless of device.
- Skip Whoop / Polar / COROS for v1, add as v2 if a friend has the device.

Total v1 add: roughly **+1 week** on top of the original sequencing, pushing the timeline to 6–7 weeks. The agent gets the resting-HR / HRV / sleep / readiness triangle and can do real overtraining detection.

If you want to stay strictly inside 4–6 weeks: ship just the **daily 1–10 readiness** for v1, add HealthKit + Garmin in v1.1 a week or two post-launch. You lose ~30 percentage points of injury-prevention performance up-front but stay on time.

### 8.4 Apple Health OAuth — does it exist?

**No. The Apple Health app and HealthKit are the same thing functionally — Health is the user-facing app on top of the HealthKit framework — and Apple deliberately does not provide a server-side API or OAuth flow for either.** This is a deliberate privacy-by-design choice and it's the single biggest difference between Apple and every other fitness platform you've worked with.

The mental model that "every modern platform has OAuth + REST" is correct for Strava, Garmin, Whoop, Oura, Polar, COROS, Withings, Fitbit, Google Fit. It is **not** correct for Apple. HealthKit data is stored locally on the iPhone, encrypted, and only accessible via the HealthKit framework, which only runs on Apple devices. There is no `oauth.apple.com/health/authorize` endpoint, and there is no plan announced for one.

Apple does have an OAuth flow specifically for **Apple Health Records** (clinical data via FHIR from healthcare providers — Epic, Cerner, etc.). That is not what you want — it's medical chart data, not the watch + iPhone-collected biometrics like resting HR, HRV, sleep, steps.

So the practical paths to get HealthKit data into your server are unchanged from §8.3:

1. **Native iOS companion app** that reads HealthKit and POSTs to your API. The "right" answer architecturally; ~2–3 weeks of scope plus App Store review and ongoing maintenance. Not for the v1 timeline.
2. **Third-party iOS app** (Health Auto Export, HealthFit) that the athlete installs and configures to POST a JSON payload to your webhook. The user pays $5–10 to the app vendor; you build a webhook receiver in ~2–3 days. Workable for friends, awkward to scale.
3. **Apple Shortcuts → webhook.** Athlete creates a Shortcut once that runs on a schedule and POSTs selected Health data. Cheaper than option 2 (no third-party app fee) but limited — Shortcuts can read steps, sleep duration, heart rate, but not all data types HealthKit exposes (HRV access via Shortcuts is unreliable). Worth knowing about, not a primary plan.
4. **Manual export ZIP upload.** User exports All Health Data from the iOS Health app and uploads it. Not real-time. Useful as a one-time backfill at signup, not as an ongoing source.

**Bottom line for §8:** there is no "just OAuth Apple Health" shortcut. Pick option 1 if biometrics-from-iPhone is core to the product long-term; option 2 if it's nice-to-have for v1 and you're OK asking friends to install another app; option 4 as a backfill convenience regardless.

### 8.5 Garmin — drop it

Confirmed your suspicion. Garmin's situation is messier than I'd implied in §8.3:

- The **Garmin Health API** (the legitimate server-side path with resting HR / HRV / sleep / stress) requires a partnership agreement that Garmin gates and reviews case-by-case. It's not something a friends-only project will get approved for in any reasonable timeframe.
- The **Garmin Connect IQ** API for apps running on the watch is real but doesn't help here — it's for on-device apps, not server data ingestion.
- The **scrape-Garmin-Connect-via-headless-browser** path (which `fetch_garmin.js` in this repo is doing) is the only thing that works without a partner agreement, and it's exactly as flaky as you've experienced. Garmin rotates auth flows, adds MFA challenges, throttles, and breaks scrapers regularly. Reddit and the `python-garminconnect` GitHub issues track this in real time.

Maintaining a multi-tenant Garmin scraper is a part-time job in itself. Drop it from the v1 scope entirely. If a friend with a Garmin watch wants their data in the loop, the realistic path is: they sync their Garmin to Apple Health (Garmin Connect → Health export is built-in for iPhone users), and you ingest via the HealthKit path. That removes Garmin scraping from your maintenance burden permanently.

### 8.6 Revised v1 plan (replaces 8.4)

Given all of §8, the version I'd actually ship:

**Keep:**

- Telegram for the daily-loop surface.
- Strava OAuth as the primary activity source.
- Manual log fallback for non-Strava users.

**Add to v1 (cheap, high-ROI):**

- **Daily wellness battery** in the morning Telegram check-in. Not just a 1–10 — go a little richer:
  - Readiness 1–10 (single tap)
  - Sleep hours (one number)
  - Soreness 1–10 + optional body-part tag
  - Optional one-line note

  This takes ~20 seconds. The Hooper questionnaire (Hooper et al., 1995) and Saw et al.'s 2016 systematic review in BJSM both find subjective wellness measures of this exact shape match or beat HRV-based monitoring for predicting maladaptation in non-elite athletes. For your audience this is genuinely competitive, not a consolation prize.

- **Weekly deeper check-in** on Sunday morning: 5 questions covering motivation, stress, perceived training load, body-area concerns, and goals/concerns for the week. ~2 minutes. Fed into the agent's weekly synthesis.

**Defer to v1.5 (post-launch, 2–4 weeks after first friends are on):**

- Health Auto Export → webhook integration for iPhone users who want real biometrics. ~3 days build.
- Whoop OAuth for any Whoop-wearing friend. ~2 days build.
- Oura OAuth same idea. ~2 days build.

**Defer to v2 (only if there's a real reason):**

- Native iOS companion app for first-class HealthKit access.
- Garmin only if Garmin ships a usable public API (not holding breath).

**Timeline impact vs. v0.1:** stays inside the 4–6 week window. Skipping Garmin saves the time we would've spent fighting it; the wellness battery costs ~1 extra day; HealthKit/Whoop/Oura slip to v1.5 as separate one-week mini-releases each, scheduled when a friend actually asks for it.

**Quality impact:** I'd actually argue this is _better_ than the v0.1 plan. Strava data + a structured daily wellness battery + weekly subjective synthesis gives the agent a richer signal than Strava + Garmin scraping (which would have been intermittent anyway). The injury-prevention story holds without depending on a fragile external ingestion pipeline. And every user — Apple, Garmin, Polar, watch-less — gets the same baseline experience.

The summary: you didn't lose much by Apple not having OAuth, because the daily wellness battery recovers most of the same signal at much lower system complexity.

---

## Appendix B — Stack alternatives considered (rejected)

- **Python (FastAPI + Celery)** — fine choice, but you lose the Vercel/Next deploy ergonomics and Inngest's TS-first DX. Pick this if you're more fluent in Python than TS.
- **Cloudflare Workers + D1** — cheap, fast at the edge, but D1 is still rough for relational schemas this size and Anthropic SDK in Workers has been finicky. Revisit at v2.
- **Bare Vercel cron, no queue** — works at 25 athletes, falls over fast as concurrency grows. Inngest costs nothing at this scale and saves you a real refactor later.
- **Supabase Edge Functions for the agent loop** — too short on max execution time for multi-minute agent runs. Use a real worker.
- **Agent SDK inside a Vercel serverless function (v0.7 — tried and rejected).** The SDK's native binary (~240 MB) doesn't fit the 250 MB function limit, and the SDK is designed to run as a long-running process anyway. Resolved by the Fly.io worker container (v0.7).
- **Hand-rolled loop on `@anthropic-ai/sdk` (v0.7 — considered, rejected).** Would fit a Vercel function but means hand-writing every tool and losing the built-in-tool improvisation that makes the personal coach good. Not worth trading the experience to stay on serverless.
