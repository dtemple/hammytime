# claude-status.md — hammytime project snapshot

> Snapshot only. The last two sessions are inline below; older session recaps and the early build log live in `Specs/archive/session-log.md`, and full history is in git. Keep this a snapshot: add a brief entry under "Last sessions" at the top and move the oldest inline session to the archive when you do — do not let this file grow back into an append-only log.

## Last sessions

_Updated: 2026-06-08 (session 46 — **coach adaptive ease-in first week (T-1 follow-up #1) — built, verified, deployed to Fly v22.** The renderer's ease-in floor (session 44, `ce6429d`) is safe but flat; this teaches the worker coach to reason about it. **Confirmed decisions (David):** (1) code-computed signal mirroring `coachMode`; (2) coach talks + offers, asks before editing week 1 (renderer's floor stays the baseline); (3) lean on thread history to avoid re-raising the framing. **Threading (worker-only, no new DB query):** `hydrate()` already loads the working plan via `loadPlanRefs` → `HydratedFolder` now also returns the parsed `plan` (`worker/folder.ts`); `run-agent.ts` passes `folder.plan` into `renderSystemPrompt(athleteId, plan?)`. **Signal (`worker/system-prompt.ts`, new exported pure `easeInContext(plan, today, race)`):** active only when week-1's `coaching_note` starts with `'Ease-in week'` (the renderer marker, kept as a local `EASE_IN_NOTE_PREFIX` constant — documented coupling, no renderer import) **and** `today ∈ [week1.start_date, week1.end_date]` — which excludes the clamped far-race plan (week 1 in the future, no ease-in note) and the same athlete past week 1. Renders a factual brief (days-left through Sunday + runway = `total_weeks`, or `N weeks to <race> on <date>` when committed) plus the shaping instruction (long week+short runway → fill it; short remainder/long runway → stay easy; frame week 2 as the first full week; ask-before-editing; don't repeat if already framed this thread). Empty string otherwise → self-suppresses mid-plan, same pattern as `{{asthma_line}}`. `coach.md` gets one `{{ease_in_context}}` line before "What a daily coaching run looks like" (covers daily + post-activity + `/adjust_plan`). Copy run through the humanizer. **Verified:** **674 tests** (663 + 11 new `easeInContext`: active days-left/runway/framing, inclusive day count Mon=7/Sun=1, week-3 inactive, clamped-far-race inactive, no-note inactive, null/undefined plan, no-residual-`{{`), typecheck, lint all green; `fly deploy` done (worker v22, poll loop healthy). **Live coaching-message capture is the remaining manual step** — onboard a mid-week test athlete on the staging group (`docs/testing-onboarding.md`) and trigger the daily run / `[Adjust it]` to confirm the message reasons about days×runway in voice, and a mid-plan run does not. **No SPEC body change needed beyond the v0.7.24 CHANGELOG entry** (the safe-floor/adaptive-coach split is already recorded there). Remaining v0.7.24 follow-up: none — both #1 (this) and #2 (regen, session 45) are done. Plan: `~/.claude/plans/make-the-daily-coach-abundant-koala.md`. Prior sessions below.)_

_(session 45 — **one-time regen of existing committed-race plans (T-1 follow-up #2) — applied to prod, verified.** The T-1 renderer fix (`856822e`) only heals new plans (`generateAndPersistPlan` reuses the active plan via `getActiveTemplatePlan`), so already-generated committed-race plans kept the wrong rendered week grid. New one-off `scripts/regen-template-plans.ts` (`npm run plan:regen`; dry-run by default, `--apply` to write): enumerates `goal_state='committed'` + `goal_race_id` athletes, rebuilds onboarding params via `buildSelectorProfile`/`selectPlan` anchored to `todayInTz`, detects a wrong **live** plan with `assertRaceDayInvariant`, and for **untouched** template plans (`current_version_id == baseline_version_id`, `generated_by='template'`) re-renders + UPDATEs `plan_versions.plan_json` in place + mirrors `plans.start_date`/`weeks` (row identity + history intact). Coach-edited plans (`current != baseline`) are **flagged, never overwritten**. Old `plan_json` backed up to `/tmp/hammytime-regen-backups/` before each write. **Trace:** the worker reads the plan directly from `plan_versions.plan_json` via `current_version_id` (`worker/folder.ts:168`), the calendar ICS does the same (`api/calendar/[token]/route.ts:49`), and there is **no `memory_files` plan copy** — fixing the version row reaches every surface, no sync needed. **Decisions (David):** silent (no Telegram — David messages Brenden); proven-wrong only; re-anchor to today; flag-and-skip coach edits. **Applied to 3 athletes, all untouched/AUTO-FIX, 0 flagged:** Brenden (`fde65f1e`, Santa Rosa, race 2026-08-23): 2 race days Aug 8+15 / ended Aug 16 → **1 race day Aug 23**, 11wk; Chase (`8453f462`, race 2026-06-19): race day Jun 11 → **Jun 19**, 2wk; David's test athlete (`a7a0902d`): **race record corrected 2026-08-23→2026-08-29 first** (David's call — `races.date` + `target_date`), then 2 race days Aug 9+16 → **1 race day Aug 29**, 11→12wk. **Verified:** re-run dry → all CLEAN; independent re-fetch asserts exactly one `type:'race'` day == `races.date`, last week contains it, `plans.weeks`/`start_date` synced, `current==baseline` intact, all 3; typecheck + lint green. Idempotent (re-run = no-op). **Note:** the regen is a full fresh render (re-pulls Strava), not a pure date patch, so volume can shift vs onboarding day — intended (matches a fresh onboarding now). Plan: `~/.claude/plans/write-and-run-a-valiant-lollipop.md`. **Only code artifact: `scripts/regen-template-plans.ts` + the `plan:regen` alias — uncommitted; the T-1 renderer fix (`856822e`) and the ease-in-week follow-up #1 (`ce6429d`) committed separately by a parallel session.** Prior sessions below.)_

_Older sessions: `Specs/archive/session-log.md`._

---

## End goal

A multi-tenant Telegram-based marathon coaching bot for ~5–25 friends. The coaching agent is the **Claude Agent SDK with its built-in tools (Read/Write/Edit/Glob/Grep/Bash/WebSearch), running in a Fly.io worker container against a per-athlete folder of files** — a near-1:1 port of David's personal coach in `~/projects/health-agent`. A daily Vercel cron *enqueues* jobs into a Postgres `job_queue`; the worker drains them (`FOR UPDATE SKIP LOCKED`), hydrates the athlete's folder from `memory_files`, runs the agent, and syncs changed files back. Athlete onboards and communicates entirely in Telegram; a minimalist web app handles allowlist sign-up, Strava OAuth, and a read-only plan view.

---

## Current status

**Architecture (v0.7, stable since 2026-05-28).** The coaching agent is the Claude Agent SDK with its built-in tools (Read/Write/Edit/Glob/Grep/WebSearch — Bash denied), running in a Fly.io worker container against a per-athlete folder hydrated from `memory_files`. A Vercel cron enqueues jobs into the Postgres `job_queue`; the worker drains them (`FOR UPDATE SKIP LOCKED`), runs the agent, and syncs changed files back. The worker is live on Fly (`hammytime-worker`, v22 — session 46's coach adaptive ease-in shaping) and draining the queue; the daily run and a real coaching message are verified clean. (Session 43 fixed a turn-wall regression where runs hit `MAX_TURNS=12` and shipped a fallback — the agent was wasting turns guessing `/home/user/...` paths; now told to read by bare filename, `MAX_TURNS` raised to 20.) The web app (signup + waitlist, Strava OAuth, plan view, admin) is on Vercel. Pivot rationale and the full per-session build history: `Specs/archive/session-log.md` and `Specs/SPEC.md`.

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
- **Exercise-grounding corpus (INTEGRATED 2026-06-02, SPEC v0.7.13)**: read-only exercise library at `worker/knowledge/exercises.md` — **24** prehab/strength exercises (stable `id` slug, form cues, verified `source`; E3 Rehab + David-curated YouTube for front plank/dead bug; Pallof press removed). **All three integration targets shipped** (brief: `docs/exercise-library-integration-prompt.md`): (1) **agent grounding** — corpus copied into the folder at hydrate (`worker/folder.ts`, in `INPUT_ONLY_FILES` so it's never synced back); `worker/prompts/coach.md` Exercise-library section. (2) **calendar** — `src/lib/calendar-render.ts` appends each exercise's `source` to its `.ics` line; slug-first via new optional `exercise_slug` on `plan-schema.ts` (set on template strength exercises) + normalized-name fallback; shared parser `src/lib/exercise-library.ts`; corpus traced into the calendar route via `next.config.ts` `outputFileTracingIncludes`. (3) **chat** — `worker/send.ts` sends `parse_mode: HTML`, the coach's `[name](slug)` tokens become tappable links (first-mention-only, escape-then-substitute per chunk, unmatched → plain text). Slug mapping decided with David: linked Split squats; left bilateral Glute bridges + Push-ups unlinked. **Still deferred:** dynamic warmup drills (leg swings, A-skips, strides, inchworm — separate "warmup/running drills" category, revisit next); companion `principles.md` (house coaching defaults) — David to author.
- **Plan-drift threshold / off-track flag** (from the working/baseline calendar work, this session): drift between the coach's working plan and the original baseline is computed and surfaced to the coach as context (`plan_drift.md`), but there's no automated "off track" alert to athlete or admin yet. Revisit once enough real coach edits exist to calibrate a sensible threshold.
- **Re-baseline action** (same work): `plans.baseline_version_id` is set once (self-healed to the first active version) and never moves — every coach edit is a working-copy edit, so drift always measures against the original. Wire a deliberate "re-plan → reset baseline" path when re-planning becomes common (race change, big fitness jump, return from injury) so drift measures against a current-realistic plan.
- **Open questions from SPEC §4**: plan schema lock-in (v1 = existing shape), "missed run" definition (planned day passes without Strava match by 11 PM local), multiple goal races (one goal + N tune-ups), Telegram daily message format, data export / portability, account deletion (hard delete within 30 days), memory hygiene / `consolidate-memory` server equivalent.

---
## Likely next task

**Plan-renderer thread (sessions 42 + 44, both uncommitted).** Two local changes are built, verified, and green but not yet committed or deployed:

1. **Commit + deploy T-1 (race-day anchoring) and the ease-in first week together.** Both touch `src/lib/plan-templates/` (renderer/selector/dates + the two test files) and ride the same Vercel deploy; no worker change is in either. Verify `npm run build` before deploying (per the predeploy-build memory).
2. **Coach adaptive-shaping fast-follow (separate Fly deploy).** Teach the worker coach to read the week-1 ease-in `coaching_note` and reason about how to use the remaining days given the runway (long partial week + short runway → get real work in; short remainder or long runway → keep it easy), framing week 2 as the first full week. Touches `worker/prompts/coach.md` / `worker/system-prompt.ts` → `fly deploy`. This is where the "learns and adapts" promise lands; the renderer only sets the safe floor.
3. **Fold both into the spec (flag for David).** T-1's anchoring behavior changes and the safe-floor/adaptive-coach division of labor want a `Specs/SPEC.md` / `ONBOARDING_V3.md` line (CLAUDE.md §2 — ask before editing the spec). Also still open from T-1: a one-time regen of existing committed-race athletes (reused plans don't self-heal).

**Onboarding v3 — only the eval harness is left.** W0–W8 shipped + on by default; **V3-W5 (the eval harness, the launch gate before opening to more friends)** is the deferred piece. After it: the ultra catalog (`Specs/ULTRA_SUPPORT.md` U1) graduates pocketed goals to real plans. (Minor: the W2 `agent_runs.kind` migration still wants applying to local Supabase.)

**Out-of-scope dependency flagged in SPEC v0.7.20 (must-fix):** the template renderer placed a real athlete's race a week early (`src/lib/plan-templates/` bug) — a broken plan undoes a good intake.
