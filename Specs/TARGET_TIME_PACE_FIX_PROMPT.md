# Target-time pace fix — compute the finish in code, not in the model

_Paste this into a fresh session. Self-contained; assumes no memory of the session
that found this. Surfaced by the V4-W6 onboarding eval (`messy-time-goal` fixture)._

## The bug

When an athlete states a **pace** instead of a finish time ("I want to run the Metro
Marathon at 10-minute miles"), the onboarding engine can store a **wrong `target_time`**
— the slot that drives the whole plan's paces — and nothing catches it.

Observed: "10 minute miles" for a marathon →
- The bot's recap **displayed** "~4:22 finish" — correct (10:00/mi × 26.2 mi = 15,720 s).
- The stored `target_time` slot was **26,200 s = 7:16:40** — a ~16:40/mi pace, nothing
  the athlete said.
- The plan would be built off 7:16 paces, ~3 hours slower than the athlete's goal.

## Root cause

1. **The model does the pace→finish arithmetic and can botch the structured fill.**
   `NUMERIC_RULES` in `src/server/telegram/onboarding/engine/extract-and-advance.ts`
   tells it: _"'10 minute miles' is a pace; compute the implied finish for the
   distance."_ The model's prose got it right (4:22) but the `target_time` value in the
   tool call diverged (26,200 s). LLM structured outputs drift from their own reasoning.
2. **The deterministic backstop can't catch an in-band error.**
   `FINISH_TIME_RANGES_SEC.marathon` is `{2:00:00 – 7:30:00}` (7,200–27,000 s) — wide on
   purpose for slow finishers. 26,200 < 27,000, so `resolveFinishTime` returns `ok`. The
   backstop catches _absurd_ values ("4-minute marathon"), not _wrong-but-plausible_ ones.
3. **The recap shows model prose, not the stored slot.** The "~4:22" the athlete
   confirmed was the model's own text; the bad 26,200 in the slot was never shown. So the
   confirm didn't catch the divergence.

**The kicker:** a `paceToFinish(secPerMile, distance)` helper already exists in
`src/server/telegram/onboarding/engine/numeric.ts` — built for exactly this case (its
header cites "10 minute miles for a marathon") — but it is **never called in the live
flow**. The code-side fix was written and never wired up.

## The fix — move the pace arithmetic into code

This is the codebase's own "model parses freeform → structured; code does the
safety-critical math" pattern (the same one `goal_distance_mi` → `deriveBucketFromMiles`
already uses). Three parts:

### 1. New extractor field: `goal_pace_sec_per_mi`

In `extract-and-advance.ts`, add `goal_pace_sec_per_mi` (nullable integer) to both
`ExtractAdvanceSchema` (Zod) and `EXTRACT_TOOL.input_schema` (the Anthropic tool),
mirroring the existing `goal_distance_mi` field.

- The model emits the athlete's stated pace as **seconds per mile** ("10 minute miles" →
  600, "8:30 pace" → 510) — a one-step conversion it does reliably.
- The model does **NOT** compute `target_time` from a pace anymore. It still emits
  `target_time` directly only when the athlete states a finish **time** ("sub-4",
  "around 3:55").

Update `NUMERIC_RULES`: replace _"'10 minute miles' is a pace; compute the implied finish
for the distance"_ with an instruction to emit `goal_pace_sec_per_mi` for a stated pace
and let the app compute the finish. Keep the `target_time`-direct path for a stated finish
time, and keep the `numeric_unresolved` ambiguity path ("4:25" hours-vs-minutes) untouched.

### 2. Compute `target_time` in the router via `paceToFinish`

In `router.ts` `runTurn` (near the `goal_distance_mi` / `applyStatedDistance` handling),
when `goal_pace_sec_per_mi` is present and the goal distance is known:

- Validate the pace against `PACE_ENVELOPE_SEC_PER_MI` (230–1500 s/mi) as a sanity rail;
  out of range → re-ask.
- Compute `target_time = paceToFinish(pace, distance)` and store it (`stated`).
- If the distance isn't known yet this turn (pace stated before the race/distance lands),
  stash the pace on `V3OnboardingState` (a new optional `goal_pace_sec_per_mi?` field —
  `onboarding_state` is JSONB, **no migration**) and apply it when the distance arrives.
  For a pocketed/real-mile distance, use the real miles (`secPerMile × miles`), not the
  bucket nominal — mirror how `resolveFinishTimeForMiles` validates against real miles.

### 3. Confirm the CODE-rendered finish, not model prose

When the router computes `target_time` from a pace, issue a confirm that echoes
`formatFinishTime(target_time)` — "10:00/mile works out to about 4:22 for the marathon —
that the goal?" — through the existing `pending_confirm` machinery on `target_time`. This
guarantees the athlete validates the **actual stored value** (it is the check that would
have caught 7:16). A correction re-asks; an affirmation confirms. Verify whether
`buildConfirmMessage` already renders `formatFinishTime` for `target_time`; if not, make
the pace-confirm render it explicitly.

## Read first (source of truth)

1. `Specs/ONBOARDING_V3.md` §5.1 — the numeric/plausibility design (the model does unit
   reasoning; code backstops). This fix moves the pace *arithmetic* to code, consistent
   with §5.1's intent ("not prompt-only, because Haiku flubbed exactly this").
2. `src/server/telegram/onboarding/engine/numeric.ts` — `paceToFinish`, `finishToPace`,
   `resolveFinishTime`, `resolveFinishTimeForMiles`, `PACE_ENVELOPE_SEC_PER_MI`, the bands.
3. `src/server/telegram/onboarding/engine/extract-and-advance.ts` — `ExtractAdvanceSchema`,
   `EXTRACT_TOOL`, `NUMERIC_RULES`, and the `goal_distance_mi` precedent (model surfaces a
   number, code derives the bucket — copy that shape).
4. `src/server/telegram/onboarding/engine/router.ts` — `runTurn`, `applyStatedDistance`,
   `backstopTargetTime`, the `pending_confirm` flow.
5. `CLAUDE.md` §9 (scoped unit — confirm before expanding), §10 (git/deploy — web-only push).

## Constraints / gotchas

- **Don't break the stated-finish-time path.** "sub-4" / "around 3:55" still emit
  `target_time` directly and still pass through `backstopTargetTime` (the "4:25"
  hours-vs-minutes ambiguity must keep working). Only the *pace* case changes.
- **A code-computed `target_time` is plausible by construction** (validated pace ×
  distance), so it does not need the backstop — but running it through `resolveFinishTime`
  is harmless (it lands in range). Don't double-confirm the same value.
- **No migration.** The new state field rides in the JSONB `onboarding_state`.
- **Web-only.** Onboarding runs in the Vercel webhook path → `commit → push` (Vercel
  auto-deploys). No `fly deploy`, no worker change.
- **Scope (`CLAUDE.md` §9):** numeric pace handling only. Don't refactor the wider engine.

## Verify / Definition of done

- Unit test: a `goal_pace_sec_per_mi: 600` fill + `marathon` distance → `target_time`
  ≈ 15,720 s (`paceToFinish`), stored `stated`; an out-of-envelope pace re-asks; the
  confirm message renders `formatFinishTime(target_time)`.
- All existing onboarding unit tests stay green; `npm run typecheck` and `npm run build`
  green.
- The V4-W6 eval `messy-time-goal` fixture passes (its `customAssertion`: `target_time`
  within the 3–6h marathon band). Re-run `npm run eval` (real Sonnet spend ~$1.6, ~12 min)
  to confirm — the rest of the gate should be unaffected.
- A stated finish time ("sub-4") still stores `target_time` directly with the
  ambiguity/backstop path unchanged.

## Spec governance (per `CLAUDE.md` §2 — apply only on sign-off)

This touches §5.1's numeric handling. On sign-off: a `Specs/CHANGELOG.md` entry recording
that the pace→finish arithmetic moved from the model into code (activating the existing
`paceToFinish`), and a one-line note in `Specs/ONBOARDING_V3.md` §5.1. Do **not** edit
`SPEC.md` unilaterally.
