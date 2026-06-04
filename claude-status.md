# claude-status.md — hammytime project snapshot

> Snapshot only. The last two sessions are inline below; older session recaps and the early build log live in `Specs/archive/session-log.md`, and full history is in git. Keep this a snapshot: add a brief entry under "Last sessions" at the top and move the oldest inline session to the archive when you do — do not let this file grow back into an append-only log.

## Last sessions

_Updated: 2026-06-04 (session 37 — **onboarding v3 W1 (slot foundation) + W2 (the per-turn engine) built & verified, uncommitted; behind the `ONBOARDING_V3` env flag (off → v2 unaffected).** `Specs/ONBOARDING_V3.md` §3/§5/§5.4. **W1** = the slot layer in **`src/server/telegram/onboarding/slots/`**: `provenance.ts` (`SlotValue<T>={value,provenance,confirmed}` — generalizes v2 enrichment's `Field`, adds the `confirmed` bit §5.4 needs), `schema.ts` (the 18-slot `SLOTS` catalog — class/source/confirmPolicy/planDriving/safety/raceOnly/numeric/knownGapKey; literal value-type unions mirroring the `athlete_training_profile` CHECKs since the generated DB types collapse to `string`; `FINISH_TIME_RANGES_SEC` per-distance plausibility table; `requiredCoreSlots(goalType)` goal-type-aware so a keep_fit athlete needs no race; `slotsToGaps` projection), `slot-state.ts` (a **new top-level `onboarding_state` shape** discriminated by `flow:'v3'`, NOT nested under v2's `{step,question,partial}`; `loadV3State`/`saveV3State`/`initialV3State`/`isV3OnboardingComplete`, `schema_version` reset-on-mismatch, cached `strava_snapshot`). **W2** = the engine in **`src/server/telegram/onboarding/engine/`**: `extract-and-advance.ts` (one Sonnet `claude-sonnet-4-6` tool call per turn → a **delta** of provenance-tagged fills + `next_action` ask/confirm/recap/generate + message + chips + race_lookup/contradiction/numeric signals; system prompt carries the humanizer voice rules; cost logged to `agent_runs` kind `onboarding`), `guardrails.ts` (**pure §5.4 enforcement that OVERRIDES the model**: generate-gate on open required slots, injury-never-`none`-by-inference, no inferred write to a safety/plan-driving slot without a confirm, hard optional-budget counter), `numeric.ts` (deterministic §5.1 backstop — `resolveFinishTime` catches the "4:25 marathon = 4 minutes" case → disambiguation chips), `commit.ts` (slot→DB write: `general_fitness`→`day_to_day`+`keep_fit`, injury `past`→`resolved`, goal_state derivation; pure `buildGoalWrite`/`mapInjuryStatus` + executors), `router.ts` (the orchestrator: idempotency via `last_processed_key`, typing indicator, extract→guardrails→numeric-backstop→race-lookup→send, and on generate → `commitSlots`→`generateAndPersistPlan`→`formatPreview` reused from v2 step 04 → phase `complete`), `typing.ts`, `history.ts`. **Entry (David's call): v3 takes over right after Strava** — `strava-resume.ts` seeds the v3 state (name/sex/tz derived slots + snapshot) + sends the orientation, **skipping v2's `00-profile-confirm`**; `bot.ts` routes `flow:'v3'` athletes to the engine until `phase:'complete'`, then to coaching, and routes `v3:` chip taps to `handleV3Callback`. **Migration** `20260604120000_agent_runs_onboarding_kind.sql` extends the `agent_runs.kind` CHECK to add `'onboarding'` **and `'race_lookup'`** (the latter was inserted in code but absent from the CHECK → those rows silently failed; latent bug fixed). **Verified:** typecheck/lint/**537 tests** (numeric 9, guardrails 18, commit 5, router 4 + W1's 27 + regressions) + format all green; **migration NOT yet applied locally** (Supabase not running — needs `npm run db:reset`). **NOT committed, NOT deployed.** **Untested = the model itself:** no live Sonnet run yet — guardrails/numeric/commit are pure-tested but extraction quality, voice, and the full conversational arc need the **W5 eval harness + a live staging-group re-onboard** (`docs/testing-onboarding.md`, `ONBOARDING_V3=true`) before opening to friends. **Known deferrals/flags (named to David):** (1) the per-athlete concurrent-turn lock is NOT built — idempotency covers Telegram retries, but two genuinely-rapid distinct messages can race two Sonnet calls → last-write-wins (one fill lost, recoverable); (2) `lookupRace` is a 2nd slower call → the race-naming turn sends a "looking it up…" message then the confirm (two messages that turn); (3) W2 ships **LLM-driven** orientation/opener/recap copy — the polished orientation, 3 structured openers, `/edit_profile` menu, and recap are **W3**; the v2 B1 `[Skip strength]`/`[Adjust]` intermediate buttons are collapsed to the Phase-D next-actions for now. **Next:** W3 (openers/recap/edit_profile), W4 (hybrid chips), W5 (eval harness — launch gate), W6 (cutover + SPEC/CLAUDE update). Plan: `~/.claude/plans/please-read-onboarding-v3-idempotent-elephant.md`. Prior sessions below.)_

_(session 36 — **V3-W0 (onboarding v3, first execution step): onboarding button taps are now logged as inbound `messages` — built & verified, uncommitted.** The typed-text path logged inbound via `logInbound`; the callback path didn't, so saved onboarding transcripts read as the bot talking to itself (`Specs/ONBOARDING_V3.md` §1.1/§8). Fix: every tap now writes a `messages` row (`direction:'in'`) carrying the **human-readable button label** (recovered off the still-intact tapped keyboard), falling back to the raw callback data when no label resolves (e.g. the message had no keyboard). New **`labelForTap(rows,data)`** extracted from `selectionKeyboardFromTap` in **`src/server/telegram/onboarding/dispatcher.ts`** (one source of truth for label recovery; re-exported via `onboarding/index.ts`); new **`logInboundTap(ctx,athleteId,data)`** called at the **top of `handleOnboardingCallback`** — before the `onb:back` intercept and before `recordSelection` collapses the keyboard to "✅ <choice>" — so it captures every step tap **and** the `← Back` tap with the label the athlete actually saw. The Phase D next-actions (`next:*`) bypass the dispatcher, so **`handleNextAction`** in `bot.ts` (now `export`ed for the test) got a mirrored inbound insert too → a complete transcript end-to-end. **No dedup** (matches the text path; a Telegram webhook retry can double-insert, same as today's typed text). **No schema/migration/worker change.** Decisions confirmed with David this session: label-as-body (treats a tap and the equivalent typed words identically, v3 principle 2) + log all taps (steps + back + next-actions). **Tests:** +4 `labelForTap` cases (`selection-keyboard.test.ts`), new `dispatcher-logging.test.ts` (3: step-tap label, `← Back` label, raw-data fallback), +1 `handleNextAction` inbound-log case (`bot.test.ts`). typecheck/lint/**474 tests**/`build` all green (466 baseline incl. the session-35 timezone work, now committed separately in `86032e3`, + 8 new). **Committed + deployed** (pushed to main → Vercel auto-deploys the webhook; **no `fly deploy`** — worker untouched). Still to verify (David, prod-side): live via the staging group harness (`docs/testing-onboarding.md`) — onboard a group test athlete, tap a `← Back` mid-section + a terminal next-action, then confirm inbound rows interleave with the bot's outbound in `messages` (or via `scripts/export-transcript.ts`) with readable labels (`Beginner`, `← Back`, `That's it for today`) rather than raw `exp:beginner` tokens. Plan: `~/.claude/plans/please-read-the-spec-cached-bunny.md`. SPEC/CLAUDE flow-shape rewrite stays deferred to v3 cutover (W6) per `ONBOARDING_V3.md` §10 — W0 is a logging fix to the live v2 flow, below the spec-flow level. Prior session below.)_

_Older sessions: `Specs/archive/session-log.md`._

---

## End goal

A multi-tenant Telegram-based marathon coaching bot for ~5–25 friends. The coaching agent is the **Claude Agent SDK with its built-in tools (Read/Write/Edit/Glob/Grep/Bash/WebSearch), running in a Fly.io worker container against a per-athlete folder of files** — a near-1:1 port of David's personal coach in `~/projects/health-agent`. A daily Vercel cron *enqueues* jobs into a Postgres `job_queue`; the worker drains them (`FOR UPDATE SKIP LOCKED`), hydrates the athlete's folder from `memory_files`, runs the agent, and syncs changed files back. Athlete onboards and communicates entirely in Telegram; a minimalist web app handles allowlist sign-up, Strava OAuth, and a read-only plan view.

---

## Current status

**Architecture (v0.7, stable since 2026-05-28).** The coaching agent is the Claude Agent SDK with its built-in tools (Read/Write/Edit/Glob/Grep/WebSearch — Bash denied), running in a Fly.io worker container against a per-athlete folder hydrated from `memory_files`. A Vercel cron enqueues jobs into the Postgres `job_queue`; the worker drains them (`FOR UPDATE SKIP LOCKED`), runs the agent, and syncs changed files back. The worker is live on Fly (`hammytime-worker`) and draining the queue; the daily run and a real coaching message are verified clean. The web app (signup + waitlist, Strava OAuth, plan view, admin) is on Vercel. Pivot rationale and the full per-session build history: `Specs/archive/session-log.md` and `Specs/SPEC.md`.

**Live in prod:** v2 Telegram onboarding (template-first plan-gen, B1 preview + adjust loop, in-section back-nav), `/checkin` wellness battery, voice-note input, typing/receipt indicators, on-demand `/fresh_update` + `/adjust_plan`, proactive post-activity + 6:30am daily coaching, exercise-library grounding + tappable chat links, `/signup` redesign + waitlist.

**In flight (uncommitted, behind the `ONBOARDING_V3` env flag — off leaves v2 unaffected):** onboarding v3, a slot-filling conversational intake replacing v2's button state machine (`Specs/ONBOARDING_V3.md`). W1 (slot foundation) and W2 (per-turn Sonnet engine) are built and unit-verified (537 tests green); the model itself is untested live, and the migration isn't applied locally yet. Detail in the session-37 block above.

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
- **Coaching-quality eval harness** (specced 2026-06-04, SPEC v0.7.19): a regression net for coaching output — golden fixtures → real `worker/run-agent.ts` agent run in an isolated folder → deterministic + Opus-judge scoring → a diffable scorecard stamped with the `coach.md` hash. Catches `coach.md` regressions before a friend reads them; the schema validator only gates plan content. Deferred / post-launch, not scheduled. One prerequisite refactor (`buildAgentOptions()` extraction from `run-agent.ts`). Full design + fixture matrix + phasing in **`Specs/EVAL_HARNESS.md`**. Phase 0 (4 fixtures + runner + judge + scorecard) is the smallest useful build.
- **Exercise-grounding corpus (INTEGRATED 2026-06-02, SPEC v0.7.13)**: read-only exercise library at `worker/knowledge/exercises.md` — **24** prehab/strength exercises (stable `id` slug, form cues, verified `source`; E3 Rehab + David-curated YouTube for front plank/dead bug; Pallof press removed). **All three integration targets shipped** (brief: `docs/exercise-library-integration-prompt.md`): (1) **agent grounding** — corpus copied into the folder at hydrate (`worker/folder.ts`, in `INPUT_ONLY_FILES` so it's never synced back); `worker/prompts/coach.md` Exercise-library section. (2) **calendar** — `src/lib/calendar-render.ts` appends each exercise's `source` to its `.ics` line; slug-first via new optional `exercise_slug` on `plan-schema.ts` (set on template strength exercises) + normalized-name fallback; shared parser `src/lib/exercise-library.ts`; corpus traced into the calendar route via `next.config.ts` `outputFileTracingIncludes`. (3) **chat** — `worker/send.ts` sends `parse_mode: HTML`, the coach's `[name](slug)` tokens become tappable links (first-mention-only, escape-then-substitute per chunk, unmatched → plain text). Slug mapping decided with David: linked Split squats; left bilateral Glute bridges + Push-ups unlinked. **Still deferred:** dynamic warmup drills (leg swings, A-skips, strides, inchworm — separate "warmup/running drills" category, revisit next); companion `principles.md` (house coaching defaults) — David to author.
- **Plan-drift threshold / off-track flag** (from the working/baseline calendar work, this session): drift between the coach's working plan and the original baseline is computed and surfaced to the coach as context (`plan_drift.md`), but there's no automated "off track" alert to athlete or admin yet. Revisit once enough real coach edits exist to calibrate a sensible threshold.
- **Re-baseline action** (same work): `plans.baseline_version_id` is set once (self-healed to the first active version) and never moves — every coach edit is a working-copy edit, so drift always measures against the original. Wire a deliberate "re-plan → reset baseline" path when re-planning becomes common (race change, big fitness jump, return from injury) so drift measures against a current-realistic plan.
- **Open questions from SPEC §4**: plan schema lock-in (v1 = existing shape), "missed run" definition (planned day passes without Strava match by 11 PM local), multiple goal races (one goal + N tune-ups), Telegram daily message format, data export / portability, account deletion (hard delete within 30 days), memory hygiene / `consolidate-memory` server equivalent.

---
## Likely next task

**Onboarding v3 (in progress, behind the `ONBOARDING_V3` flag).** Per the session-37 plan and SPEC v0.7.20, the remaining workstreams:

1. **W3** — polished orientation, the 3 structured openers, the recap before plan-gen, and the `/edit_profile` menu (W2 ships LLM-driven placeholder copy for these).
2. **W4** — hybrid chips for ≤3-option answers.
3. **W5** — the onboarding eval harness (launch gate): a fixture set asserting the invariants (injury always asked / never healthy-from-skip, no `generate` with a required slot open, over-answers not re-asked, numeric disambiguation correct, field-targeted corrections, contradictions surfaced).
4. **W6** — cutover to v3 as default (flag kept only as a fast fallback) + the SPEC §3.9 / CLAUDE.md reconcile.
5. **V3-W7** — non-race `coach.md` branch so a no-race athlete's daily coaching isn't race-framed.

Before opening to friends: a live staging-group re-onboard (`docs/testing-onboarding.md`, `ONBOARDING_V3=true`). Plan file: `~/.claude/plans/please-read-onboarding-v3-idempotent-elephant.md`.

**Out-of-scope dependency flagged in SPEC v0.7.20 (must-fix):** the template renderer placed a real athlete's race a week early (`src/lib/plan-templates/` bug) — a broken plan undoes a good intake.
