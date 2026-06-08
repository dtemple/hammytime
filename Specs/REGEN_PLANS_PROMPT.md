# One-time regen of existing committed-race plans — fresh-session prompt

Paste the section below into a new session. It is self-contained.

---

Write and run a one-time regeneration that brings existing committed-race athletes' persisted plans in line with the T-1 race-day fix. **Read the source-of-truth first:** `Specs/ONBOARDING_V3_LIVE_FIXES.md` (§T-1/T-9), the T-1 implementation plan at `~/.claude/plans/please-make-a-plan-zany-clarke.md`, the session 42 entry in `claude-status.md`, and the `CLAUDE.md` rules (source-of-truth, §7 commands, the `docs/testing-onboarding.md` notes about running against PROD). Confirm the T-1 commit is present (`git log` — `fix(plan-templates): anchor committed-race plans to the real race date (T-1)`, `856822e`, deployed 2026-06-08).

**If you have suggestions based on your knowledge of the code or the user experience, please surface those suggestions** — don't just execute. The decisions below are the ones I know about; raise anything else you'd recommend.

## Background
The T-1 fix corrected the renderer so a committed-race plan renders exactly one `type:'race'` day on the real race date, anchored so the last week is the race week. It fixes plan generation **going forward only**: `generateAndPersistPlan` (`src/server/telegram/onboarding/plan-gen.ts`) reuses an athlete's existing active plan via `getActiveTemplatePlan`, so already-generated plans do **not** self-heal. At least one real athlete (Brenden / Santa Rosa Marathon, race 2026-08-23) has a persisted plan with `type:'race'` days on the wrong dates (Aug 8 + Aug 15) and a plan that ends before the race. `metadata.race.date` is already correct; only the rendered week grid (`plan_json.weeks`) is wrong.

## Goal
Bring affected athletes' persisted plans in line with the fixed renderer — exactly one race day on the real date, anchored to the race week — **without clobbering any coach customizations**, and reaching every surface that reads the plan.

## Key code to understand
- `src/server/telegram/onboarding/plan-gen.ts`: `generateAndPersistPlan` (idempotency guard — reuses the active plan), `getActiveTemplatePlan`, `persistTemplatePlan` (inserts a `plans` row + one `plan_versions` row, sets it as BOTH `current_version_id` and `baseline_version_id`, and writes `plans.start_date` + `plans.weeks`), and `setPlanStrengthToZero` (the precedent for an in-place re-render that UPDATEs `plan_versions.plan_json`).
- **Version model:** at onboarding, `current_version_id == baseline_version_id` (one `generated_by:'template'` version). The coach's `[Adjust it]` / worker customization forks a new working version via `record_plan_edit` → `current_version_id` advances, `baseline_version_id` stays. So `current != baseline` means the athlete has coach edits you must not silently overwrite.
- `src/lib/plan-templates/`: re-render with `selectPlan` + `renderPlan`; `renderPlan` now calls `assertRaceDayInvariant` (throws unless exactly one race day on `params.race.date`) — use it to both detect wrong plans and validate regenerated ones.
- `scripts/` one-offs (e.g. `import-plan.ts`, `verify-plan.ts`, `clear-athlete-plans.ts`) are the pattern to mirror for a new `scripts/regen-template-plans.ts`, run via `npx tsx`. **`.env.local` points at PROD** (per `docs/testing-onboarding.md`) — this touches live athlete data, so build it dry-run-first and supervised.

## Requirements
- **Detect affected athletes:** committed-race (`goal_state='committed'`, `goal_race_id` set) with an active template plan whose persisted `plan_json` fails the race-day invariant (not exactly one `type:'race'` day equal to `metadata.race.date`). Re-rendering and comparing is the reliable detector; don't guess from generation timestamps.
- **Re-render with the athlete's current local date** (`todayInTz(athlete timezone)`), so the new plan is correctly anchored to weeks-remaining as of now. (This is the same thing a fresh onboarding today would produce; it may be a week or two shorter than the original — see decisions.)
- **Preserve coach edits:** if `current_version_id != baseline_version_id`, **do not overwrite** — flag the athlete for manual review. For untouched template plans (`current == baseline`, `generated_by='template'`), update the version's `plan_json` in place and mirror `persistTemplatePlan`'s side effects (`plans.start_date`, `plans.weeks`), keeping the row identity + history intact.
- **Dry-run by default:** print a per-athlete diff (old race day(s) + span → new race day + span, week-count change, untouched-vs-edited). Only write under an explicit `--apply` flag. Validate every regenerated plan with `assertRaceDayInvariant` before writing.
- **Reach every surface:** confirm how the worker coach obtains the plan — directly from `plan_versions.plan_json` at hydrate, or via a copy synced into the athlete's `memory_files` folder. If there's a `memory_files` copy, the regen must update that too. **Trace it; don't assume.** (The calendar ICS route reads `plan_json`, so it's covered once the version row is fixed.)

## Decisions to surface (ask David)
- **Notify or silent?** Should affected athletes get a short Telegram heads-up that their plan's schedule was corrected (Brenden saw a preview with the wrong dates), or fix it silently?
- **Scope:** regen only proven-wrong plans, or all committed-race template plans (to pick up the corrected anchoring even where the old race day happened to land close)?
- **Re-anchor date:** regen with today (recommended — reflects reality, matches a fresh onboarding now) vs. preserving the original start date / week numbering.
- **Coach-edited plans:** flag-and-skip for manual review, or attempt a re-anchor that preserves the edits?
- **Anything else** you'd recommend from the code or the athlete experience — raise it.

## Scope (do not expand)
A single one-off script (plus the `memory_files` sync if the trace shows it's needed). Do **not** change the renderer, selector, or onboarding engine — they're fixed. Do not add libraries.

## Verification
- Dry-run against prod; review the diff with David before any write.
- `npm run typecheck`, `npm run lint`.
- After `--apply`: re-fetch each affected athlete's `plan_json` and assert exactly one `type:'race'` day on the real race date; spot-check the calendar ICS and (if applicable) the worker's plan view.
- Update `claude-status.md` per `CLAUDE.md` §8.

When done: summarize which athletes were regenerated and which were flagged for manual review, the before/after per athlete, and any suggestions you surfaced.
