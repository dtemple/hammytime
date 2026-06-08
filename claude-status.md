# claude-status.md — hammytime project snapshot

> Snapshot only. The last two sessions are inline below; older session recaps and the early build log live in `Specs/archive/session-log.md`, and full history is in git. Keep this a snapshot: add a brief entry under "Last sessions" at the top and move the oldest inline session to the archive when you do — do not let this file grow back into an append-only log.

## Last sessions

_Updated: 2026-06-08 (session 44 — **ease-in first week: a mid-week onboarder's week 1 no longer prescribes a hard or already-elapsed effort — built & verified, uncommitted.** Fast-follow to T-1 (session 42, also uncommitted). `Specs/EASE_IN_WEEK_PROMPT.md`; plan `~/.claude/plans/implement-the-ease-in-first-majestic-rabbit.md`. **Division of labor (David's call):** the deterministic renderer (no-LLM; owns the instant preview + persisted baseline) does a *safe floor* only — the **coach (Agent SDK)** owns the adaptive shaping + voice, which is a fast-follow, not this unit. **Renderer (`src/lib/plan-templates/renderer.ts`, `buildWeeks`):** new per-week `isEaseInWeek` = `wi===0 && week contains params.startDate` (= `profile.today`, the sign-up day) — true for the common committed/intended/keep_fit case, **false** for a clamped far-race plan whose week 1 starts in the future (the required guard). In the day map, **after** the T-1 race-day block (so the race day still places first — invariants hold even in a 1-week plan where week 1 == race week): rest days `< startDate` (elapsed) and `=== startDate` (sign-up day); the remainder is plain easy warm-ups (long-run slot → rest, quality → easy). Week 1 gets an ease-in `coaching_note` carrying the facts the coach reasons from. Two interactions handled: `placeStrength` skips the elapsed/sign-up days in the ease-in week; `validateSafety` exempts week-2's `weekly_ramp`/`long_run_step` when week 1 is the ease-in week (its long run is 0 by design → the first real long run reads as a 0→N jump, not an escalation — same philosophy as the cutback re-ramp exemption). `planned_total_run_miles` for week 1 stays `vol.totalMi` so the week-2 ramp baseline is normal. **Preview (`04-plan-preview.ts`, `formatPreview`):** a "Week 2 is your first full week" line, only when week 1 is a partial ease-in (excludes the clamped case + 1-week plans); two variants (remainder vs signed-up-on-the-week's-last-day). **Decisions (David):** keep the existing week count (no added week); **uniform** ease-in incl. Monday onboarders; messaging **preview-only** now. Copy run through the humanizer (tightened one tailing-negation note). **Verified:** **663 tests** (657 + 6 new: 4 renderer ease-in incl. Monday / clamped-not-eased / week-1==race-week, 2 preview), typecheck, lint all green. **NOT committed, NOT deployed.** **Fast-follow (not done):** coach `coach.md` / `system-prompt.ts` adaptive shaping — read the ease-in note, reason about remaining days × runway, frame week 2 (separate Fly deploy); fold the safe-floor/adaptive-coach split into SPEC/ONBOARDING_V3 (flag for David). T-1 + ease-in both still need committing. Prior sessions below.)_

_(session 43 — **worker fix: coach runs were hitting the 12-turn wall and shipping the SOFT_FALLBACK — fixed, committed (`860ef7a`), deployed to Fly v21.** David's athlete (`6182da86…`) got the fallback ("Hit a snag pulling your update together…") for **both** the daily check-in and the post-activity report. Root cause from `agent_runs`/`agent_run_steps`: both runs ended `Reached maximum number of turns (12)`, so `run-agent.ts` set `runError` → `SOFT_FALLBACK`. Two compounding causes — (1) **the agent didn't know its cwd**: `run-agent.ts:66` passes `systemPrompt` as a plain string, which replaces Claude Code's default preset incl. the `<env>` working-dir block, and `coach.md:5` named no path, so the agent guessed `/home/user/...`, the isolation guard (`worker/isolation.ts:86`) denied them as folder escapes, and it burned ~half its turns on a `Glob **/*` rediscovery before any real work; (2) **`MAX_TURNS=12` had no margin** once the Dipsea-week plan rewrite David approved the night before (6+ sequential `Edit`s) ran. Earlier the same heavy runs died on **max-budget**; raising the budget $0.5→$1 (`7c59046`) moved the bottleneck onto turns (5 max-turns failures total, 3 that day). **Fix:** `worker/prompts/coach.md` now tells the agent its files sit in the cwd, read by bare filename, never `/home/user/...`; `worker/config.ts` `MAX_TURNS` 12→20 (the $1 `MAX_BUDGET_USD` cap is the real cost bound). **Verified by re-running the failed daily job** (fresh `job_queue` row, distinct key): clean run `2249e3fa` — `error: None`, $0.56, **0** `/home/user` reads, **0** `Glob **/*` discovery; it applied the plan edits *and* delivered a real coaching message to David's Telegram. **Follow-ups (deferred, not done):** (a) the post-activity run edited the plan despite the prompt's "Don't change the plan yourself this turn" (`system-prompt.ts:239`) — reinforce later; (b) coach runs are cost/turn-heavy in general — the budget/persistence rework the $1 stopgap points at is still owed. Plan: `~/.claude/plans/i-m-working-on-daybreak-async-bunny.md`. Prior sessions below.)_

_Older sessions: `Specs/archive/session-log.md`._

---

## End goal

A multi-tenant Telegram-based marathon coaching bot for ~5–25 friends. The coaching agent is the **Claude Agent SDK with its built-in tools (Read/Write/Edit/Glob/Grep/Bash/WebSearch), running in a Fly.io worker container against a per-athlete folder of files** — a near-1:1 port of David's personal coach in `~/projects/health-agent`. A daily Vercel cron *enqueues* jobs into a Postgres `job_queue`; the worker drains them (`FOR UPDATE SKIP LOCKED`), hydrates the athlete's folder from `memory_files`, runs the agent, and syncs changed files back. Athlete onboards and communicates entirely in Telegram; a minimalist web app handles allowlist sign-up, Strava OAuth, and a read-only plan view.

---

## Current status

**Architecture (v0.7, stable since 2026-05-28).** The coaching agent is the Claude Agent SDK with its built-in tools (Read/Write/Edit/Glob/Grep/WebSearch — Bash denied), running in a Fly.io worker container against a per-athlete folder hydrated from `memory_files`. A Vercel cron enqueues jobs into the Postgres `job_queue`; the worker drains them (`FOR UPDATE SKIP LOCKED`), runs the agent, and syncs changed files back. The worker is live on Fly (`hammytime-worker`, v21) and draining the queue; the daily run and a real coaching message are verified clean. (Session 43 fixed a turn-wall regression where runs hit `MAX_TURNS=12` and shipped a fallback — the agent was wasting turns guessing `/home/user/...` paths; now told to read by bare filename, `MAX_TURNS` raised to 20.) The web app (signup + waitlist, Strava OAuth, plan view, admin) is on Vercel. Pivot rationale and the full per-session build history: `Specs/archive/session-log.md` and `Specs/SPEC.md`.

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
