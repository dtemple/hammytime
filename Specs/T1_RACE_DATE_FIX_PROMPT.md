# Fix: rendered race day is wrong (T-1) — drop-in prompt for a fresh session

_Paste everything below the line into a fresh Claude Code session in the hammytime repo._

---

Fix the plan renderer so a committed race's race-day lands on the real race date, exactly once. This is T-1 in `Specs/ONBOARDING_V3_LIVE_FIXES.md` — read that section (T-1a, T-1b, T-9) and re-read the relevant plan-gen spec section before changing anything, per the source-of-truth rule in `CLAUDE.md`.

## The bug (proven from prod data + the code)

A real athlete onboarded ~11 weeks out from the Santa Rosa Marathon (race 2026-08-23, generated 2026-06-07, long-run day Saturday). The `races` row, `plans` row, `plan_version`, and `metadata.race.date` were all correctly 2026-08-23 — but the single rendered `plan_json` contained **two** `type:'race'` days, on 2026-08-08 and 2026-08-15, and the plan ended Aug 16 (a week before the race). One clean plan, two wrong race days, none on the real date. Two compounding defects:

**T-1a — `allocateCounts` ignores phase caps when the timeline is short.** `src/lib/plan-templates/renderer.ts` `allocateCounts` (the `weeks >= n` "over-compressed" branch, ~line 163) round-robins the remainder by `minWeeks` desc **without honoring `maxWeeks` or `minWeeks`**. `marathon-finish` has a 12-week phase minimum (`minSum = 12`); `selector.ts:241` computed `totalWeeks = floor(whole_weeks_between(today, targetDate)) = floor(77/7) = 11`. `11 < 12` → over-compressed branch → it allocates `base=2 build=3 peak=2 taper=2 race=2`: `race` exceeds its `maxWeeks:1` and `base` is under its `minWeeks:3`. Two `basePhase==='race'` weeks → `buildWeeks` (~line 383) emits a race day in each → Aug 8 and Aug 15.

**T-1b — placement is never anchored to the race date.** `selector.ts:343` sets `startDate = today`; `buildWeeks` marches forward from `mondayOf(startDate)` and drops the race day on `params.longRunDay` of the race week — not the race's real weekday, and never tied to the real date. `mondayOf(today)` snaps back up to 6 days, `floor(weeks)` truncates up to 6 more, so the race week lands a week-plus early and on the wrong weekday (markers on Saturday though Aug 23 is a Sunday).

## Target invariants

After the fix, for any committed race (`goal_state === 'committed'`, a real `race.date`):

1. The rendered plan contains **exactly one** `type:'race'` day, and its date **equals** `metadata.race.date`.
2. No phase exceeds its `maxWeeks`; no phase drops below its `minWeeks` unless the runway genuinely can't fit the minimums (then drop whole phases from the front — keep taper/race — never overflow a capped phase).
3. The plan's final week is the week containing the race date; earlier weeks fill backward from there.

Open-ended plans (`keep_fit` / intended, `totalWeeks === null`) have no race date and must be unchanged.

## Recommended approach (you own the implementation — design the cleanest version)

- **T-1a:** make `allocateCounts` honor `maxWeeks` (and `minWeeks` where feasible) in the over-compressed branch. The capped phases (race, taper, peak) must never receive more than `maxWeeks`.
- **T-1b:** anchor the schedule to the race week. Derive the race week as the week containing `race.date`; set the plan length and start so the last week is that race week; place the race-day entry on the race's actual weekday (from `race.date`), and suppress the long run / easy run that would otherwise occupy the race-week slots. Clamp length to `MAX_PLAN_WEEKS` (a far-off race starts later than today, not earlier than the race). If the runway is shorter than `MIN_PLAN_WEEKS`, prefer a shorter correct plan over misplacing the race day.
- **T-9 (the guard):** add a generation-time assertion in the render path that invariant #1 holds — exactly one `type:'race'` day, equal to `metadata.race.date`. Fail loudly at gen time (this path runs inline on the bot and is supposed to be deterministic and correct). This single check catches both T-1a and T-1b and any future regression.

## Decisions to surface, not guess

`startDate = today` is likely to change (anchoring derives start from the race week). If your implementation makes plans start on a date other than today for some runways (e.g., a far race starting later, or a short runway running fewer than `MIN_PLAN_WEEKS`), that's a user-visible behavior change — call it out in your summary and ask David before treating it as settled, per the working agreement and spec-governance rule. Do not silently change `MIN_PLAN_WEEKS`/`MAX_PLAN_WEEKS` semantics without flagging it.

## Tests + verification (required)

- Add a renderer test for the exact failure: `marathon-finish`, today `2026-06-07`, race `2026-08-23`, long-run day Saturday → assert exactly one `type:'race'` day on `2026-08-23`, and that the plan's last week contains it.
- Add a property/table test across templates and a range of runways (e.g., 4–24 weeks out, race weekday both equal to and different from the long-run day): invariants #1–#3 hold every time; specifically assert no phase exceeds `maxWeeks`.
- Extend/keep the existing plan-template tests green; re-baseline any snapshot that legitimately shifts because plans now anchor to race day (expected — note which and why).
- Run `npm run test`, `npm run typecheck`, `npm run lint` (see `CLAUDE.md` §7) and report results.

## Scope boundaries (do not expand)

- Renderer + selector + their tests only. Do **not** touch the onboarding engine, the gap-walk, the injury schema, or the worker — those are separate tracked issues (T-3…T-8).
- Do **not** write a data migration or regenerate existing athletes' plans. Already-generated plans are reused by `generateAndPersistPlan` and won't self-heal; a one-time regen is a separate follow-up — name it in your summary but don't do it here.
- Do **not** add the `races` unique-constraint / idempotent-insert work (T-2) — the prod data showed it isn't implicated.
- If you find the fix requires a spec-level decision, stop and ask rather than deciding unilaterally.

When done: summarize what changed, the before/after for the Brenden scenario, any behavior change you're flagging for confirmation, and the test results.
