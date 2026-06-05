# Prompt — v3 engine hardening: confirm-loop + stale goal_date

_Paste everything below this line into a fresh session._

---

Fix two live-breaking bugs in the onboarding v3 engine (`src/server/telegram/onboarding/engine/`). Both were hit by real users on 2026-06-05; the evidence transcripts are in the repo. This is a scoped hardening pass on the W2 engine — no new features, no enum changes, no catalog work (that's `Specs/ULTRA_SUPPORT.md`, separate).

Read first: `claude-status.md` (the v3 build is uncommitted, behind the `ONBOARDING_V3` flag — sessions 37–38), `Specs/ONBOARDING_V3.md` §5/§5.4 and §1.2, and the two transcripts named below.

## Bug 1 — the deterministic-confirm loop

**Evidence:** `transcripts/chaseheaton_gmail.com.md` 14:00–14:25 — "Quick check — I've got your days per week as 3. Right?" sent **seven times** against seven "Looks right" replies, over 85 minutes. Same loop earlier in that transcript and in `transcripts/davidjtemple_gmail.com.md` on `goal_distance`.

**Root cause (verified, two parts):**

1. **`mergeFills` wipes prior confirms.** `engine/guardrails.ts` (~line 114): every fill is written with `confirmed: !needsConfirm(slot, provenance)`. The model is told to emit only changed slots, but it re-emits unchanged ones — and a re-emitted `inferred` fill for an already-confirmed slot resets `confirmed` to false. Each "Looks right" turn can therefore *un-confirm* slots, and the generate-gate (`firstUnconfirmedInferred`) re-fires the same deterministic confirm.
2. **No pending-confirm bookkeeping.** When the generate-gate override sends `buildConfirmMessage` for a slot, nothing records that this confirm is outstanding. The next inbound ("yes" / "Looks right" / a chip tap — chip taps also round-trip through Sonnet, `engine/router.ts` `handleV3Callback` → `runTurn`) resolves only if the model happens to re-emit that slot with `stated` provenance. It often doesn't, so the gate finds the same unconfirmed slot and repeats itself, forever.

**Fix — three invariants, enforced in code:**

1. **Merge monotonicity.** A fill whose coerced value equals the slot's current value must never clear `confirmed` or downgrade provenance (`stated` stays `stated`). Only a *changed* value resets the confirm. This alone kills the wipe class.
2. **Pending-confirm bookkeeping.** Add a `pending_confirm: { slot, value } | null` (shape yours to choose) to `V3OnboardingState`, set whenever a guardrail-issued confirm goes out. On the next inbound: a `yes`-valued chip tap resolves it **in code with no model call** (set `confirmed: true`; flipping provenance to `stated` is correct — the athlete just affirmed the value to their face). Typed text still goes through the model, but `summarizeState` must name the pending confirm so the model knows what "looks right" refers to.
3. **Never the same confirm three times.** Keep a per-slot attempt count. If the same slot+value confirm would go out a third time, change strategy instead: send a direct ask naming the field in plain words ("Want to be sure I've got this — how many days a week are you running?") so the athlete's restatement arrives as a `stated` fill. Repeating a question the athlete has answered twice is never the right move.

Mind the v2 lesson while doing this: do **not** build a rigid typed-yes parser (the "Yep!" failure is in `ONBOARDING_V3.md` §1.1). Deterministic resolution is for chip taps, where the value is exact; typed replies stay model-interpreted, backstopped by the attempt counter.

## Bug 2 — stale `goal_date` across a goal change

**Evidence:** `transcripts/chaseheaton_gmail.com.md`, the 14:00 recap: "Rae Lakes Loop 44mi — **June 19, 2026**." June 19 is Broken Arrow's looked-up date; the goal had switched to Rae Lakes (September) and the date silently survived. The demoted race lost its date in the same exchange ("Broken Arrow 18k (date TBD)" in the final recap, despite a successful lookup earlier).

**Root cause:** `resolveRace` (`engine/router.ts`) writes `goal_race` + `goal_date` together, which is correct — but when the *model* emits a `goal_race` fill (goal change, no lookup) without a `goal_date` fill in the same delta, the previous race's date persists.

**Fix:**

1. **Code rule** (in `mergeFills` or a post-merge step, your call): when a fill changes `goal_race` to a different value and the same delta carries no `goal_date` fill, reset `goal_date` to unfilled/`unknown`. The gate will re-ask or the model will re-fill — either beats a wrong date reaching the plan.
2. **Prompt rule** (one or two lines in `extract-and-advance.ts` rules): when the goal race changes, restate `goal_date` explicitly or mark it open; when a former goal race is demoted to a tune-up, carry its name *and date* into `tune_up_races`.

## Verification

- Unit tests in the existing suites (`guardrails` and router/engine tests): the monotonic merge, pending-confirm resolution by chip tap, the third-attempt strategy change, and goal_date invalidation. Add regression cases shaped on the two transcripts (the exact fill sequences that produced the loop and the stale date).
- `npm run typecheck`, `npm run lint`, `npm run test`, prettier on changed files only (there is pre-existing repo-wide format drift in `worker/` — leave it).
- Update `claude-status.md` per the house convention. Note in your wrap-up that a live staging-group pass (`docs/testing-onboarding.md`, `ONBOARDING_V3=true`) is still required before friends see this — these fixes are part of that gate, not a substitute for it.

## Scope guards

- Do not touch the v2 onboarding path, the worker, or `src/lib/plan-templates/`.
- No enum or catalog changes; no uncatalogued-goal pocket (V3-W8 — separate work).
- No new state beyond the pending-confirm bookkeeping.
- If you find the fix wants to expand beyond these two bugs, stop and ask.
