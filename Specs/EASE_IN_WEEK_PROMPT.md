# Ease-in first week + onboarding messaging — fresh-session prompt

Paste the section below into a new session. It is self-contained.

---

Implement the "ease-in first week" for newly-generated template plans, and communicate it to the athlete. This is the agreed fast-follow to the T-1 race-day renderer fix (see `Specs/ONBOARDING_V3_LIVE_FIXES.md` and the T-1 record in `claude-status.md`, session 42). **Read the relevant section of `Specs/SPEC.md` and the source-of-truth rule in `CLAUDE.md` before changing anything.** The T-1 implementation plan, which this builds on, is at `~/.claude/plans/please-make-a-plan-zany-clarke.md` — read it for the anchoring context.

## Background: what T-1 already did
The deterministic plan renderer (`src/lib/plan-templates/renderer.ts`, `selector.ts`) now anchors a committed-race plan so its **last week is the race week** and the race day lands on the real date. Anchoring is "cover-from-today" (the decision David picked): for the common (unclamped) case the plan starts on `mondayOf(today)`, and `params.startDate` carries the generation day — i.e. the day the athlete finishes onboarding (`profile.today`, set in `computeRenderParams`). So for a committed plan, **week 1 is the current Mon–Sun calendar week and `params.startDate` falls inside it.** (Exception: a far race clamped to `MAX_PLAN_WEEKS` starts in the future, so week 1 does not contain today.)

Confirm the current code state first — the T-1 work may or may not be committed (check `git log`/`git status`); the behaviors above should be present in `buildWeeks`.

## The problem
When an athlete onboards mid-week, week 1 currently renders as a normal training week. Two issues:
1. It can prescribe a **hard effort (long run / quality / tempo) on days already elapsed, or on the sign-up day itself.** David's framing: "If the user signs up at 10pm and you tell them to do a tempo run that day, it's not going to make any sense."
2. The plan preview (`{total_weeks} weeks to {race}`) gives **no signal that week 1 is partial** — it just reads as a full first week.

## Desired behavior (David's intent — you own the cleanest implementation)
- The plan should effectively **begin the day after sign-up.** In the partial first week: **rest the days before the sign-up day and the sign-up day itself**; the **remainder of that week is a few easy warm-up runs** — no long run, no quality/hard session.
- **Communicate it clearly**, in the bot voice. David's example copy: *"Week 2 will be your first full week and we'll use the remainder of this week to get a few warm up runs in."* He stressed: **the communication is the most important part.**

## Decisions to surface, not guess (ask David per the working agreement)
1. **Does the ease-in week stay within the existing week count, or do we add a week?** Recommended: keep week 1 as the existing allocated week (its phase label stays; only its *content* softens to a ramp-in). This avoids re-touching the T-1 allocation/anchoring and adds no week — the lost intensity in a single partial week is negligible. The alternative (preserve a full base phase by inserting a "week 0" ramp-in → `totalWeeks + 1`, re-anchor) is heavier and changes the count semantics. Confirm before settling.
2. **Monday onboarders.** If the athlete finishes onboarding *on* a Monday, week 1 is a full Mon–Sun week from today. Is it still framed/rendered as an ease-in (uniform "week 2 is your first full week"), or only the sign-up day softened? Recommended: still ease-in (uniform, simplest messaging), but surface it.
3. **Scope of the messaging.** Does the ease-in framing belong only in the onboarding preview, or also in the daily coach (`worker/prompts/coach.md` / `worker/system-prompt.ts`) so the first morning message matches? Confirm whether to touch the worker (it's a separate deploy — `fly deploy`, not just Vercel).

## Where the code lives
- **Renderer week-1 softening:** `src/lib/plan-templates/renderer.ts`, `buildWeeks`. It already special-cases the **race week** in its per-day map (race day placed first/unconditionally, post-race days rest, long run suppressed) — use that as the pattern for a "week 1 ease-in" special case. `buildWeeks` has `params.startDate` (the sign-up day) and each day's `date`, so it can classify week-1 days as `date < startDate` (elapsed → rest), `date === startDate` (sign-up day → rest), `date > startDate` (remainder → easy warm-up, no long run/quality). Reuse the existing inline `rest` day objects and `easyDayEntry(...)`.
  - **Guard:** apply ease-in only when week 1 actually contains the sign-up day (a clamped far-race plan starts in the future — week 1 is a normal future week, no ease-in).
  - **Do not break the T-1 invariants.** In very short plans week 1 can also be the race week / taper week. The race-day placement and `assertRaceDayInvariant` must still hold — layer the ease-in so it never clobbers the race day or reintroduces a race-week long run. Keep the T-1 race-week handling intact.
- **Messaging:** `src/server/telegram/onboarding/steps/04-plan-preview.ts`, `formatPreview` — the committed-race branch is ~lines 61–69 (and there are keep_fit / intended branches). Add the "week 2 is your first full week / rest of this week eases in" line **only when week 1 is a partial ease-in** (e.g. derive from the plan: week 1 contains a rest-the-elapsed-days shape, or compute from `params.startDate` vs `ps.start_date`). Keep it in the existing Daybreak voice.

## Hard rules for the copy (athlete-facing, read daily)
Must not read as AI-generated. No sycophancy. Avoid the "That's not X. That's genuine Y." pattern. Avoid the words "genuinely," "honestly," "straightforward," "niggle." Follow the humanizer guidelines at https://github.com/blader/humanizer.

## Scope boundaries (do not expand)
- Renderer week-1 logic + the preview (and, if confirmed, the coach) messaging + their tests. **Do not** change the T-1 anchoring, the week count, or `allocateCounts`.
- **Do not** regenerate existing athletes' plans (a separate one-time regen is its own follow-up).
- Do not add libraries. Do not refactor surrounding code beyond what the change needs.
- If the fix needs a spec-level decision, stop and ask rather than deciding unilaterally.

## Tests + verification (required)
- Renderer tests: a mid-week sign-up (e.g. `today` = a Wednesday) → assert week 1's elapsed days and the sign-up day are `rest`, the remainder are easy (no `long_run`, no quality/tempo/intervals/hill_repeats in week 1); a Monday sign-up behaves per decision #2; a clamped far-race plan (week 1 in the future) is **not** eased.
- Keep the **T-1 tests green** — especially the Brenden regression and the cross-template property test (runways 4–24); confirm ease-in doesn't break the "exactly one race day on the real date" / "no long run in the race week" invariants, including the short-plan edge where week 1 == the race week.
- Preview test: the "week 2 is your first full week" line appears when week 1 is a partial ease-in and is absent otherwise.
- Run `npm run test`, `npm run typecheck`, `npm run lint` (see `CLAUDE.md` §7) and report results.

When done: summarize what changed, show a concrete before/after for a mid-week onboarder (which week-1 days became rest vs. easy, and the preview copy), flag any behavior change for confirmation, and report test results. Update `claude-status.md` per `CLAUDE.md` §8.
