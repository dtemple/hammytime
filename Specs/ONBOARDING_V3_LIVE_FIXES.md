# Onboarding v3 — live-transcript fixes (Brenden, 2026-06-07)

_Status: **draft / brainstorm for review.** Not folded into `SPEC.md` or `ONBOARDING_V3.md` yet — per the source-of-truth rule, the spec stays authoritative until David signs off on these. Source: `transcripts/bmulderr_gmail.com.md` (a live v3 run, 2026-06-07 — distinct from the 2026-06-03 v2 run already written up in `ONBOARDING_V3.md` §1.1). File:line references are from the state of the repo on 2026-06-07._

This is a tracked issue list with proposed fixes, scope, and the downside of each. Ranked by leverage. The two structural ones (T-1, T-3) each cause several visible symptoms; T-5 is the safety one.

---

## T-1 · Renderer emits two (wrong) race days · P0 · renderer

> **Shipped 2026-06-08 (SPEC v0.7.24 — see the change log for the authoritative record).** T-1a, T-1b, and the T-9 gen-time assertion all landed, plus the agreed ease-in first week fast-follow. The change-log entry supersedes this section.

**Symptom.** A single rendered plan held `type:'race'` on **both Aug 8 and Aug 15**; real race Aug 23. Confirmed by the diagnostic query: one clean `races` row (Aug 23), one plan, one `plan_version`, `metadata.race.date` and `target_date` both correct at Aug 23 — the wrong dates live only in the rendered week grid. Deterministic: same inputs reproduce it, which is why it survived `/restart` and recurred from the v2 run.

This is **two compounding bugs**:

**T-1a — `allocateCounts` over-compressed branch ignores phase caps (the two race days).** `marathon-finish` has a phase minimum of `minSum = 12` weeks. Brenden onboarded ~11 weeks out and `selector.ts:241` computed `totalWeeks = floor(whole_weeks_between(June 7, Aug 23)) = floor(77/7) = 11`. Since `11 < minSum`, `renderer.ts allocateCounts` (`:163` the `weeks >= n` branch) distributes the remainder round-robin by `minWeeks` desc **without honoring `maxWeeks` or `minWeeks`**. Verified by simulation: it yields `base=2 build=3 peak=2 taper=2 race=2` — `race` blown past its `maxWeeks:1`, `base` under its `minWeeks:3`. Two `basePhase==='race'` weeks → `buildWeeks` (`:383`) emits a race day in each → Aug 8 (week 10 Sat) and Aug 15 (week 11 Sat). At `weeks>=12` the normal branch caps correctly (`race=1`). _Fix:_ make the over-compressed branch respect min/max caps (cap race at 1; never silently violate a min). Small, contained, one function, guarded by renderer tests. **This is the cheap high-value fix — it kills the duplicate marker on its own.**

**T-1b — placement is never anchored to the real race date.** Even with one race week, the marker is wrong. `startDate = today` (`:343`) then `buildWeeks` (`:335`) marches forward from `mondayOf(startDate)`, and `:383` drops the race day on `params.longRunDay` of the race week — not the race's actual weekday. Two losses stack: `mondayOf(June 7)` snaps back to June 1 (up to 6 days early) and `floor(weeks)` truncates the partial final week (up to 6 more). Net: the 11-week plan ends Aug 16 — the Aug 23 race falls *outside the plan*, and the markers sit on Saturday though the race is a Sunday. _Fix:_ anchor the race week to the week containing `raceDate`, place the race-day entry on the race's true weekday, and size weeks to cover the date (ceil-to-cover, not floor). Add a gen-time assertion that there is **exactly one** `type:'race'` day and it equals `metadata.race.date` (see T-9) — that single check catches both T-1a and T-1b.

**Downside / risk.** T-1a is low-risk and should ship first: it only corrects an allocation that's already out of spec, and the renderer tests are the guard (add an explicit "weeks < minSum honors caps" case). T-1b is the bigger one — it touches the deterministic core every plan flows through, so re-sizing weeks shifts the base/build/peak/taper distribution for *every* athlete and the renderer tests need re-baselining. Edge cases: race weekday ≠ long-run day (race week may carry both a long run and the race — suppress/move the long run); a sub-`MIN_PLAN_WEEKS` runway (`clampInt` at `:241` fights anchoring the end to race day — decide whether short-runway plans may run shorter than the min). Open-ended (`keep_fit`/intended) plans have no date and are unaffected. Already-generated plans won't self-heal — `generateAndPersistPlan` reuses the active plan — so existing committed-race athletes need a one-time regen.

---

## T-2 · Non-idempotent race insert → possible duplicate race rows · P2 · schema + commit

**Status: NOT implicated in the date bug.** The diagnostic query (2026-06-07) returned exactly one `races` row, one plan, one `plan_version` for Brenden — no duplicates. The "3 dates" were entirely T-1 (the renderer). This downgrades from P0 to a latent hardening, kept because the gap is real even though it didn't fire here.

**Root cause (in code).** `commit.ts:175` does a plain `.insert()` into `races`; the table (`20260518000000_initial_schema.sql:51`) has no unique constraint. A Telegram webhook retry or a double-commit within one onboarding *could* add a second row. `/restart`'s RPC (`20260603000000_reset_athlete_onboarding.sql`) deletes races/plans, so restart isn't a leak.

**Proposed fix.** Delete the athlete's prior `upcoming` race(s) before insert (onboarding commits exactly one goal race), or add a unique key + `upsert` with a deliberately chosen conflict target — `(athlete_id, name)` rather than `(athlete_id, name, date)`, so a legit date correction updates rather than inserting a new row. If adding a `UNIQUE`, dedupe any existing rows first or the migration fails to apply.

---

## T-3 · "Finish my profile" re-asks answered questions on a loop · P1 · v3 engine / router

**Symptom.** `/edit_profile` → "Finish my profile" re-asked the same two gaps ("tune-up races?", "longest run?") every invocation despite answers; ignored the athlete's real coaching questions in between; said "Got it — that's everything" then re-asked on the next tap.

**Root cause (confirmed in code).** The gap-walk (`router.ts:517 runGapWalkTurn`) is a **separate deterministic queue**, not the slot engine. It *calls* `callExtractAndAdvance` (`:535`) but **discards the model's `message` and `next_action`** (`:529–530` comment) and emits a hard-coded `gapQuestion(...)`. So the phrasing is identical every time and the athlete's questions are steamrolled. On re-entry, `startGapWalk` (`:494`) rebuilds the queue from `parseKnownGaps(...)` open list; the round-trip through `seedKnownGapsFromFilled` isn't idempotent against re-parse, so a just-answered gap can reappear `[open]` and get re-asked. A completed walk isn't recognized as complete.

**Proposed fix.** Two tiers.

- *Cheap, zero-downside (ship now):* before asking a queued gap, skip it if the backing slot is already filled in `state.slots`; don't re-ask within a session; recognize an empty remaining-gap set and exit; fix the non-idempotent known-gaps round-trip so an answered gap stays filled.
- *Richer (T-7):* route the engine's `message` through so the athlete's freeform input (including questions) gets a real reply instead of the canned next question.

**Downside / risk.** The cheap tier has essentially none — it only suppresses redundant asks, and the Sonnet call is already being paid for (so wiring its output through is *more value for the same cost*). The richer tier needs the engine gated into a "fill-only" mode post-completion so it can't trigger a `recap`/`generate` action outside onboarding.

---

## T-4 · A rich first message only acknowledges the race · P1 · v3 engine

**Symptom.** Brenden's opening message carried experience (~6 wks), first marathon, "priority is a regular running practice," a trail-vs-neighborhood preference, multi-part injuries, and a question. The bot replied only about the race; the rest *felt* dropped (injuries did survive; preferences/philosophy did not).

**Root cause (confirmed in code).** When `race_lookup_query` is set, `router.ts:225–235` runs `resolveRace` and **replaces the model's entire message** with "Found it — …, That the one?". Other slots filled that turn are merged into state but never acknowledged.

**Proposed fix.** When the lookup fires alongside other fills, fold a one-line "got the rest too — training shape and that knee, we'll come back to them" into (or right after) the race confirm. Keep the race confirm itself deterministic. Low risk; mostly copy/flow.

---

## T-5 · Multi-part injuries truncated to one · P1 · schema (safety-relevant)

**Symptom.** "Right knee, both ankles, right shoulder" → recap showed "right knee + ankles," shoulder dropped; one `injuries` row written. For an athlete whose defining feature is several nagging spots, the safety signal is the thing getting truncated.

**Root cause (confirmed in code).** `slots/schema.ts` `InjuryDetail` holds a single `body_part`. The extract tool, recap (`guardrails.ts recapInjuryLine`), and commit (`commit.ts:223 commitInjury`, one `.insert()`) all assume one.

**Proposed fix.** Make `injury_detail` an array of `{ body_part, status }`; recap echoes all; `commitInjury` inserts N rows; the renderer's injury overlay already iterates `profile.injuries`, so it benefits automatically.

**Downside / risk.** Touches the extract tool schema, recap, and commit together — moderate, contained. Worth pulling into the P0 batch on safety grounds even though the symptom is "only" a dropped body part.

---

## T-6 · Asks for longest run that Strava already has · P1 · v3 engine

**Symptom.** "What's the longest run you've done?" → "16 miles. Can't you see that in Strava?"

**Root cause (confirmed in code).** `recent_long_run` is a known-gap with no backing slot. It's seeded open only when `snapshot == null` (`selector.ts:336`), but the gap-walk still surfaces it, and the Strava snapshot already computes `longest_run_mi` (`strava/activities.ts`, surfaced to the model at `extract-and-advance.ts` as "longest recent run ~16 mi").

**Proposed fix.** Pre-fill `recent_long_run` from `snapshot.longestRunMi` when present; keep it an open gap only when the snapshot is genuinely thin (`run_count === 0`). Same principle for strength equipment if already known. Low risk.

---

## T-7 · Direct athlete questions never answered · P2 · v3 engine

**Symptom.** "Does Strava tell you how old I am?" (then the bot asked age 20 min later); "Is 10 min/mile realistic on the Santa Rosa course?" (asked twice, ignored both); "Can you see my calendar?". The engine only extracts + advances; it has no path to answer.

**Proposed fix.** Give the engine a reply affordance — answer a quick question, then continue the slot it was on. The marathon-pace-realism question is exactly what the product should be strong at (Strava history + the marathon predictor). Downside: adds a response mode and a little latency; scope it so it doesn't turn onboarding into open-ended chat.

---

## T-8 · No home for training philosophy / terrain preference · P2 · v3 engine

**Symptom.** "Priority is a regular running practice" (a `keep_fit`-leaning signal worth surfacing) and "trail but I run the neighborhood" both fell on the floor — no slot, not echoed, not in the recap.

**Proposed fix.** Capture into `motivation` / a light preferences slot, echo in the recap, and let the terrain signal inform the trail overlay. Low risk.

---

## T-9 · Onboarding preview never flagged the wrong date · P2 · handoff

> **Done in two halves.** The renderer half (the gen-time "exactly one race day == `metadata.race.date`" assertion) shipped 2026-06-08 with T-1 (SPEC v0.7.24). The input half was absorbed into **R1** (`Specs/ONBOARDING_REFLECTION.md`, 2026-06-10): a past `goal_date` is reset to unknown at merge time, and `commitSlots` refuses outright (`PastTargetDateError`) before any write — a wrong date can no longer reach generation at all.

**Symptom.** The 7:41 plan preview ("11 weeks to Santa Rosa, peaking at 17") gave no hint the schedule ended Aug 15; the worker caught it 11 min later on `/fresh_update`. Per `ONBOARDING_V3.md` §9, plan correctness shouldn't depend on the worker noticing a renderer bug.

**Proposed fix.** The gen-time assertion from T-1 (rendered race day == `metadata.race.date`) — fail or self-correct at generation rather than relying on the coach. Low risk; this is the safety net that makes T-1 stay fixed.

---

## Draft spec amendments (for review — not yet applied)

If these are accepted, the following in `ONBOARDING_V3.md` need updating, and a `SPEC.md` / `CHANGELOG.md` entry should record the batch:

- **§8 "Dependencies outside v3's scope" — the plan-gen race-date bug** is still live and is now P0 with a confirmed mechanism (T-1). Upgrade from "named dependency" to an open must-fix, and add the gen-time assertion as its guard.
- **§3 / §5 slot schema — `injury_detail`** should be multi-valued (T-5); current single-`body_part` shape is a safety gap.
- **§4 `/edit_profile` "Finish my profile"** should run through the engine, not a parallel deterministic loop — skip already-filled and Strava-derivable gaps, recognize completion, and answer questions (T-3, T-6, T-7). This contradicts the current `runGapWalkTurn` design.
- **known-gaps — `recent_long_run`** should be Strava-derived, not asked when a snapshot exists (T-6).
- **New invariant — race insert must be idempotent** (T-2); add to the §5.4 code-guardrails list.

## Suggested sequencing

**First batch (kills the most-visible symptoms):** T-1a (allocateCounts honors caps — small, contained, removes the duplicate race day) + T-9 (the gen-time "exactly one race day == race date" assertion, which guards both T-1a and T-1b) + the cheap tier of T-3 (skip already-filled gaps, recognize completion).

**Second batch:** T-1b (anchor placement to the real race date — the bigger core change; do it with the renderer tests re-baselined) and T-5 (multi-part injuries, safety).

**Later:** T-4, T-6, T-7, T-8 polish the same engine. T-2 is latent hardening, no urgency (not implicated in the live bug).
