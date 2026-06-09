# claude-status.md — hammytime project snapshot

> Snapshot only. The last two sessions are inline below; older session recaps and the early build log live in `Specs/archive/session-log.md`, and full history is in git. Keep this a snapshot: add a brief entry under "Last sessions" at the top and move the oldest inline session to the archive when you do — do not let this file grow back into an append-only log.

## Last sessions

_Updated: 2026-06-09 (session 53 — **calendar-oauth built end-to-end (`Specs/CALENDAR_OAUTH.md`; CHANGELOG v0.7.30): Google Calendar direct-write into a per-athlete "Daybreak — training" calendar, ICS feed unchanged for everyone else. Three commits pushed (`c21eca6`, `e8fb3dc`, `d51b648`); migration applied to prod; INERT until David does Part 0.** Part 1: per-day event construction extracted to `planToCalendarEvents` ([src/lib/calendar-events.ts](src/lib/calendar-events.ts)) + `loadCalendarRenderInput` ([src/server/plans/active-plan.ts](src/server/plans/active-plan.ts)) — ICS and Google emit one event set; the untouched calendar-render snapshot is the parity proof. Part 2: Strava-shaped OAuth (`src/server/google/`, `/google/connect|callback|connected`, `oauth_tokens` provider `google_calendar` + new `provider_calendar_id` column, scope `calendar.app.created` only); callback verifies the granted scope, requires a refresh token, creates the Daybreak calendar inline (reuses it on reconnect — no duplicates), enqueues the ~154-event first fill as the new `calendar_sync` job (the worker's first non-agent kind, dispatched in [worker/poll.ts](worker/poll.ts)); `reconcileCalendar` ([src/server/google/sync.ts](src/server/google/sync.ts)) = one whole-calendar list + local iCalUID diff + throttled import/patch/delete (75ms gap, 429 backoff), idempotent, deletes only `@hammytime` UIDs; a revoked grant (`invalid_grant` on refresh) tears the connection down terminally + messages the athlete with the ICS fallback. **Google refresh returns no refresh_token — the stored one is preserved, pinned by test.** Part 3: `enqueueCalendarSyncIfConnected` fires on calendar-confirm promotion, onboarding plan-gen, and strength-zero (in-place rewrite that moves no version pointer); nightly reconcile cron 2am PT; `/calendar` offers Connect-button + ICS link (both-options decided; existing Google ICS subscribers opt-in); `/disconnect_calendar` deletes the calendar + revokes + drops the row. 792 tests, typecheck, lint, build green. **Remaining:** (1) **Part 0 — David, manual:** Google Cloud project + Calendar API, consent screen (homepage daybreak.run, privacy /privacy — both pages exist), **gate: `calendar.app.created` must show *sensitive*, not *restricted*, on the scope picker**, OAuth client with redirects `https://daybreak.run/google/callback` + `http://localhost:3000/google/callback`, publish to Production (Testing = 7-day refresh-token death), submit sensitive-scope verification (unverified warning screen is fine for dogfood, 100-user cap), then `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` on Vercel + Fly + .env.local. (2) **`fly deploy`** for the worker's `calendar_sync` dispatch — held this session (permission denial on a stale clean-tree concern; tree was clean at attempt time; harmless to defer since nothing enqueues without the env vars). (3) David's voice pass on all new bot/web copy (the `/calendar` dual-option message, connect/connected/disconnect strings, the revoked-grant message, web connect/connected pages). (4) Live e2e once Part 0 lands. Prior sessions below.)_

_(session 52 — **prehab v2 built (`Specs/PREHAB.md` P1+P2; CHANGELOG v0.7.29). Code + corpus committed + pushed; `fly deploy` is HELD on David's P1 science sign-off of `worker/knowledge/prehab-principles.md`.** New read-only corpus (load→tissue map, day-type prehab roles, dose/selection rules; its header carries a PENDING SIGN-OFF line to flip at sign-off). **`coach.md` §Prehab rewritten** — the hard-coded priorities line (the multi-tenant bug) is deleted; new content: the two-layer model (standing routine surfaced only on its 2–3 scheduled days; contextual layer 0–2 items each with a named observable cause — recent activity, injury_log entry, race demand, soreness trend; "nothing" is a valid prescription), authoring + revision instructions for the agent-authored `prehab_program.md` (skeleton inline; day-type anchors are the truth, the weekday line is a re-derivable cache so rolled-over weeks can't leave it stale), the 7-day `checkin_log.md` read-back with acknowledge-the-thread repetition. Daily-run item 4 → day-type role; ad-hoc prehab only when relevant; post-activity may carry one time-sensitive item; Never list swaps "Skip prehab" for never-skip-on-its-day / never-re-list-off-schedule; check-in log now records prehab "none" explicitly. `missionLine()` ([worker/system-prompt.ts](worker/system-prompt.ts)) drops its prehab clause in both modes; [worker/folder.ts](worker/folder.ts) generalizes `CORPUS_SRC` → a `KNOWLEDGE_FILES` list (third corpus is now a one-line add). **Decision (David, in-session): program authoring also triggers on a direct athlete prehab ask**, not only the first daily run (PREHAB.md §3 amended). **Verified:** 717 tests (new: both corpora hydrate + never sync back, agent-authored `prehab_program.md` does sync back, mission line carries no prehab clause), typecheck, lint, build green. Worker-only, no migration. **Remaining: David vets the §4 science (cut, don't hedge) → flip the sign-off line → `fly deploy` → watch his own transcript ~a week against the §6 criteria.** No backfill — each athlete's first daily run post-deploy authors their program as a consolidation. Prior sessions below.)_

_Older sessions: `Specs/archive/session-log.md`._

---

## End goal

A multi-tenant Telegram-based marathon coaching bot for ~5–25 friends. The coaching agent is the **Claude Agent SDK with its built-in tools (Read/Write/Edit/Glob/Grep/Bash/WebSearch), running in a Fly.io worker container against a per-athlete folder of files** — a near-1:1 port of David's personal coach in `~/projects/health-agent`. A daily Vercel cron *enqueues* jobs into a Postgres `job_queue`; the worker drains them (`FOR UPDATE SKIP LOCKED`), hydrates the athlete's folder from `memory_files`, runs the agent, and syncs changed files back. Athlete onboards and communicates entirely in Telegram; a minimalist web app handles allowlist sign-up, Strava OAuth, and a read-only plan view.

---

## Current status

**Architecture (v0.7, stable since 2026-05-28).** The coaching agent is the Claude Agent SDK with its built-in tools (Read/Write/Edit/Glob/Grep/WebSearch — Bash denied), running in a Fly.io worker container against a per-athlete folder hydrated from `memory_files`. A Vercel cron enqueues jobs into the Postgres `job_queue`; the worker drains them (`FOR UPDATE SKIP LOCKED`), runs the agent, and syncs changed files back. The worker is live on Fly (`hammytime-worker`) and draining the queue — the latest worker deploy is session 51's calendar-confirm cutover (coach plan edits stage a proposal; the athlete's Yes tap moves the calendar); session 47's Fix C (dropped-plan-edit alerts) was the deploy before it. The daily run and a real coaching message are verified clean. (Session 43 fixed a turn-wall regression where runs hit `MAX_TURNS=12` and shipped a fallback — the agent was wasting turns guessing `/home/user/...` paths; now told to read by bare filename, `MAX_TURNS` raised to 20.) The web app (signup + waitlist, Strava OAuth, plan view, admin) is on Vercel. Pivot rationale and the full per-session build history: `Specs/archive/session-log.md` and `Specs/SPEC.md`.

**Live in prod:** **onboarding v3** (the default flow — `ONBOARDING_V3` is now a kill-switch, on unless explicitly set to `false`/`0`/`off`; slot-filling conversational intake, Sonnet engine + code guardrails, orientation gate, three openers, recap, `/edit_profile` (in the BotFather menu), the uncatalogued-goal pocket), `/checkin` wellness battery, voice-note input, typing/receipt indicators, on-demand `/fresh_update` + `/adjust_plan`, proactive post-activity + 6:30am daily coaching (non-race `coach.md` branch live on Fly v18), exercise-library grounding + tappable chat links, `/signup` redesign + waitlist.

**Onboarding v3 — wrapped up (2026-06-05), except the eval harness.** All workstreams committed + deployed (intake on Vercel, the W7 worker coach branch on Fly v18): W0 (tap logging), W1 (slot schema/state), W2 (per-turn Sonnet engine + the session-39 hardening pass: merge monotonicity, pending-confirm bookkeeping, never-three-times, goal_date invalidation), W3 (orientation/openers/recap, `/edit_profile` + known-gaps walk), W4 (hybrid chips), W6 (cutover to default), W7 (non-race coach branch), W8 (uncatalogued-goal pocket + code distance derivation, commit `603f3fd`). A full live Sonnet staging pass has been run and `/edit_profile` is in the BotFather menu. **`isV3Enabled()` now defaults ON** — the env flag is a kill-switch back to v2, not an enable-switch (completes decision #3). Docs reconciled to built reality: SPEC §3.9 rewritten to v3, CHANGELOG v0.7.23, ONBOARDING_V3 §8 statuses, CLAUDE.md §4. **The one remaining piece — V3-W5, the eval harness (the launch gate before opening to more friends) — is deferred by decision; we come back to it.** (Minor: the W2 `agent_runs.kind` migration still wants applying to local Supabase.) **Next after W5:** the ultra catalog (`Specs/ULTRA_SUPPORT.md` U1) graduates pocketed goals from the marathon-proxy to real structured plans.

---

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
- **Ultra support + uncatalogued goals (specced 2026-06-05, two passes, unscheduled)**: both 2026-06-05 live tests (`transcripts/davidjtemple_gmail.com.md` — Western States 100; `transcripts/chaseheaton_gmail.com.md` — 44mi non-race) wedged on the closed `goal_distance` enum, and the Chase transcript exposed two v3 engine bugs (a deterministic confirm repeated 7× against 7 "Looks right" replies — `mergeFills` wipes confirms on re-emitted fills + no pending-confirm bookkeeping; and a stale `goal_date` surviving a goal change). The work split three ways: **(1) bug fixes** — ✅ **DONE session 39** (merge monotonicity, pending-confirm resolution, never-same-confirm-3×, goal_date invalidation; `Specs/V3_HARDENING_PROMPT.md`, uncommitted, still needs the live staging-group pass); **(2) engine behavior** — new **V3-W8** in `ONBOARDING_V3.md` (§5.2 uncatalogued-goal pocket: acknowledge → proxy-with-consent → store the athlete's words; §5.3 deterministic bucket-from-`distance_mi` derivation; new eval fixtures + decisions #9–10); **(3) catalog expansion** — **`Specs/ULTRA_SUPPORT.md`** second pass (granular `50k`/`50mi`/`100k`/`100mi` buckets as internal training archetypes, U1 = enum plumbing + `ultra-50k` + non-race events + distance-derived plausibility, U2 = `ultra-endurance` + back-to-back long-run renderer work, volume goals analyzed-and-deferred in §6). Open: DRAFT cap/envelope numbers, time_goal suppression, U1 scheduling vs W4–W6. SPEC.md/CLAUDE.md untouched pending sign-off.
- **Coaching-quality eval harness** (specced 2026-06-04, SPEC v0.7.19): a regression net for coaching output — golden fixtures → real `worker/run-agent.ts` agent run in an isolated folder → deterministic + Opus-judge scoring → a diffable scorecard stamped with the `coach.md` hash. Catches `coach.md` regressions before a friend reads them; the schema validator only gates plan content. Deferred / post-launch, not scheduled. One prerequisite refactor (`buildAgentOptions()` extraction from `run-agent.ts`). Full design + fixture matrix + phasing in **`Specs/EVAL_HARNESS.md`**. Phase 0 (4 fixtures + runner + judge + scorecard) is the smallest useful build.
- **Exercise-grounding corpus (INTEGRATED 2026-06-02, SPEC v0.7.13)**: read-only exercise library at `worker/knowledge/exercises.md` — **24** prehab/strength exercises (stable `id` slug, form cues, verified `source`; E3 Rehab + David-curated YouTube for front plank/dead bug; Pallof press removed). **All three integration targets shipped** (brief: `docs/exercise-library-integration-prompt.md`): (1) **agent grounding** — corpus copied into the folder at hydrate (`worker/folder.ts`, in `INPUT_ONLY_FILES` so it's never synced back); `worker/prompts/coach.md` Exercise-library section. (2) **calendar** — `src/lib/calendar-render.ts` appends each exercise's `source` to its `.ics` line; slug-first via new optional `exercise_slug` on `plan-schema.ts` (set on template strength exercises) + normalized-name fallback; shared parser `src/lib/exercise-library.ts`; corpus traced into the calendar route via `next.config.ts` `outputFileTracingIncludes`. (3) **chat** — `worker/send.ts` sends `parse_mode: HTML`, the coach's `[name](slug)` tokens become tappable links (first-mention-only, escape-then-substitute per chunk, unmatched → plain text). Slug mapping decided with David: linked Split squats; left bilateral Glute bridges + Push-ups unlinked. **Still deferred:** dynamic warmup drills (leg swings, A-skips, strides, inchworm — separate "warmup/running drills" category, revisit next). The companion `principles.md` (house coaching defaults) gets its first installment as `prehab-principles.md` in the prehab v2 build (`Specs/PREHAB.md`, session 50); the broader house-defaults file remains David-to-author.
- **Plan-drift threshold / off-track flag** (from the working/baseline calendar work, this session): drift between the coach's working plan and the original baseline is computed and surfaced to the coach as context (`plan_drift.md`), but there's no automated "off track" alert to athlete or admin yet. Revisit once enough real coach edits exist to calibrate a sensible threshold.
- **Re-baseline action** (same work): `plans.baseline_version_id` is set once (self-healed to the first active version) and never moves — every coach edit is a working-copy edit, so drift always measures against the original. Wire a deliberate "re-plan → reset baseline" path when re-planning becomes common (race change, big fitness jump, return from injury) so drift measures against a current-realistic plan.
- **Open questions from SPEC §4**: plan schema lock-in (v1 = existing shape), "missed run" definition (planned day passes without Strava match by 11 PM local), multiple goal races (one goal + N tune-ups), Telegram daily message format, data export / portability, account deletion (hard delete within 30 days), memory hygiene / `consolidate-memory` server equivalent.

---
## Likely next task

**Calendar-oauth — activate it (built session 53, inert; CHANGELOG v0.7.30).** In order: (1) **Part 0, David, manual** — Google Cloud project + Calendar API; consent screen (External; homepage `https://daybreak.run`, privacy `https://daybreak.run/privacy`); add scope `calendar.app.created` and **gate-check it shows *sensitive*, not *restricted*** (restricted → stop, per `Specs/CALENDAR_OAUTH.md`); OAuth web client with redirect URIs `https://daybreak.run/google/callback` + `http://localhost:3000/google/callback`; **publish to Production** (Testing kills refresh tokens in 7 days) + submit sensitive-scope verification (unverified warning screen is fine for dogfood); set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` on Vercel + Fly (`fly secrets set`) + `.env.local`. (2) **`fly deploy`** (held session 53) so the worker can drain `calendar_sync`. (3) **Voice pass** on the new copy: `/calendar` dual-option message + `Connect Google Calendar` button, connect/connected/disconnect strings, the revoked-grant message (`worker/jobs/calendar-sync.ts`), web `/google/connect` + `/google/connected` pages. (4) **Live e2e on David's athlete:** `/calendar` → connect → Daybreak calendar fills (~154 events); coach edit → tap Yes → the changed day updates in Google within seconds; `/disconnect_calendar` → calendar gone; re-run the nightly enqueue → 0 writes.

**Prehab v2 — observation week only (built, vetted, deployed session 52; CHANGELOG v0.7.29).** Watch David's own transcript for ~a week against the `Specs/PREHAB.md` §6 acceptance criteria: routine on its 2–3 days and no others; contextual items always name their cause; persisting signals repeat with acknowledgment; a plan reshuffle moves the weekday mapping without dropping anchors; a second athlete's program reflects *their* injuries (the multi-tenant fix). No backfill — each athlete's first daily run post-deploy authors their program file as a consolidation. D-heavy (prehab → calendar) stays deferred pending this observation (§7).

**Calendar-confirm — voice pass + live verification (the feature is otherwise done).** Both halves shipped (sessions 49 + 51; CHANGELOG v0.7.26 + v0.7.28). Remaining: (1) **David's voice pass on all the draft copy** — the `Update your calendar?` keyboard text + `Yes, update` / `No, leave it` button labels (`worker/send.ts`), the bot-side resolved messages (`✓ Calendar updated.` / `Left as-is.` / expired, `src/server/telegram/bot.ts`), and the superseded-keyboard edit; message-2 change summaries ("Wed: 4 → 6mi") deferred to this same pass. (2) **Live end-to-end on David's own athlete:** ask the coach to move a future workout → prose + keyboard → check `plans.proposed_*` set and `current_version_id` unmoved → tap Yes → promoted + ICS reflects it; then a second proposal tapping No; optionally a third to watch the supersede edit. Check fly logs for the hook firing and keyboard-send errors.

**Onboarding v3 — only the eval harness is left.** W0–W8 shipped + on by default. **V3-W5 (the coaching-quality eval harness — the launch gate before opening to more friends)** is the deferred piece; design + fixture matrix in `Specs/EVAL_HARNESS.md`, smallest useful build is Phase 0 (4 fixtures + the real `worker/run-agent.ts` in an isolated folder + Opus judge + diffable scorecard). One prerequisite refactor: extract `buildAgentOptions()` from `run-agent.ts`. (Minor: the W2 `agent_runs.kind` migration still wants applying to local Supabase.)

**Then: the ultra catalog (`Specs/ULTRA_SUPPORT.md` U1).** Graduates out-of-catalog goals from the marathon-proxy to real structured plans (granular 50k/50mi/100k/100mi archetypes, non-race events, distance-derived plausibility). Now has a concrete waiting customer: Chase (`8453f462`) is on a hilly-trail-marathon **proxy** for a 44mi Sierra run (session 48) — U1 is what replaces that proxy with a real ultra build.

**Watch: v2/v3 `onboarding_state` drift.** Session 48 found four step-only "is this athlete onboarded?" gates that silently excluded every v3 athlete (v3 stores `phase`, no `step`); all now route through the shared `isOnboarded()` (`src/server/telegram/onboarding/index.ts`). Any new code that reads `onboarding_state.step` directly to decide onboarded-ness re-opens the same bug class — use `isOnboarded()`.

**Loose end (human, not code): David to text Chase** about his rebuilt plan + the ultra-proxy caveat. Session 48 fixed his data (race date, terrain, timezone, 15-week plan) but deliberately did not message him — the daily cron will start messaging him each morning, so reach out before then.

**Shipped, no longer "next" (was stale here):** the plan-renderer thread — T-1 race-day anchoring (`856822e`), ease-in first week (`ce6429d`), coach adaptive-shaping (Fly v22), and the one-time committed-race regen (session 45) — is fully committed + deployed. The SPEC v0.7.20 "race placed a week early" bug was that same T-1 fix.
