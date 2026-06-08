# Coach adaptive ease-in week — fresh-session prompt

Paste the section below into a new session. It is self-contained.

---

Make the daily coach (the Agent SDK worker) reason adaptively about an athlete's **ease-in first week** and frame it warmly, instead of just reading the safe-floor week the renderer produced. This is the agreed fast-follow to the ease-in first week shipped in **SPEC v0.7.24** (`Specs/CHANGELOG.md`; renderer/preview side done in commit `ce6429d`). **Read `Specs/CHANGELOG.md` v0.7.24 and the source-of-truth rule in `CLAUDE.md` before changing anything.** This is a **worker** change — a separate Fly deploy (`fly deploy`), not a Vercel push.

## Background: what already shipped (don't redo it)

When an athlete onboards mid-week, the deterministic renderer (`src/lib/plan-templates/renderer.ts`, `buildWeeks`) now produces a **safe floor** for week 1: it rests the already-elapsed days and the sign-up day, keeps the remainder to easy warm-up runs (no long run, no quality), and tags week 1 with an ease-in `coaching_note`. The two text variants (`easeInNote` in `renderer.ts`):
- remainder left in the week: *"Ease-in week. You're starting partway through the week, so the rest of it stays easy. Long runs and harder sessions start in week 2, your first full week."*
- signed up on the week's last day (no remainder): *"Ease-in week. You're joining at the end of the week, so this week is rest. Week 2 is your first full week."*

The onboarding preview already says "Week 2 is your first full week."

**The division of labor (David's call, the whole point of this fast-follow):** the renderer is no-LLM and only sets a conservative floor — it deliberately does **not** decide how to shape the partial week. The **coach owns the adaptive shaping and the voice.** That's this task.

## The problem this solves

The renderer's floor is safe but flat: it can rest the athlete's long-run day and stamp two easy runs regardless of context. David's framing of what the coach should do instead, in his words:

> Given the length of the first week and the time until their goal/race, how can we help the runner make the most of the time available? A long week on a short training window can be handled differently than a short week on a long training window.

So the coach should look at **two variables** — how many days are left in the ease-in week, and how long the runway to the goal/race is — and reason:
- **Long remaining week + short runway** → don't waste it. An easy run today, and it's reasonable to get a real (easy) long run in before week 2 if the days allow.
- **Short remainder, or a long runway** → keep it genuinely easy; a couple of shakeouts, start properly in week 2. No need to rush.
- Either way: **frame week 2 as the first full week**, warmly, so the partial week reads as intentional rather than a broken-looking plan.

The coach already reads the plan as a file each run, so it can *see* the ease-in week. What's missing is the instruction (and ideally a precise signal) to reason about it and talk about it on the athlete's first interactions.

## Where the code lives

- **`worker/prompts/coach.md`** — the coaching prompt. It already has a "What a daily coaching run looks like" section and a post-activity section, and uses `{{var}}` placeholders substituted by `worker/system-prompt.ts`. Add an **ease-in-week** instruction here.
- **`worker/system-prompt.ts`** — derives `coachMode` (committed / intended / no_race / unknown) and feeds placeholders into `coach.md`. This is the natural place to compute an ease-in signal in code and expose it as placeholders, mirroring how `coachMode` is done.
- **`src/server/agent/byo-plan.ts`** (`loadAthleteData`) — loads the plan + training profile the system prompt reads. Check what's already available (it loads the plan and `goalRace`); the plan's week 1 `coaching_note` + `start_date`/`end_date` and `metadata.plan_structure.total_weeks` are what you need.

## The design decision to make (surface it, don't guess)

**How does the coach know it's the ease-in week, and how precise a signal does it get?** Two options:

1. **Prompt-only (lightest).** Add a `coach.md` section telling the coach: if this week's plan note starts with "Ease-in week" and today falls inside it, reason about the remaining days and the runway, and frame week 2 as the first full week. The coach infers days-left and runway from the plan it already reads. Lowest code, but leans on the model to read dates correctly.
2. **Code-computed signal (recommended, mirrors `coachMode`).** In `system-prompt.ts`, compute from the plan + today whether today is in the ease-in week, how many run-able days remain in it, and the runway (`total_weeks`, and weeks-to-race for a committed plan). Expose as placeholders (e.g. `{{ease_in_context}}`) that render a short factual brief into `coach.md` when active, and render empty otherwise. Deterministic; the model reasons about the shaping, not the date arithmetic. Slightly more code, but the date math is exactly the kind of thing to keep out of the model.

Recommend **option 2** and confirm before building. Whichever is chosen, the coach should only bring this up while the athlete is actually in the ease-in week (the first daily run after onboarding, and the post-onboarding `[Adjust it]` run) — not forever.

## Scope of the reasoning (keep it bounded)

- The coach **may suggest** an easy run today / an easy long run later this week / starting properly Monday — as conversation. Whether it should **edit the plan** to add those sessions, or just talk about them, is a sub-decision: the existing `coach.md` rule is "ask before changing the plan" on the post-activity path. Default to **talk + offer, ask before editing** unless you decide otherwise — surface it.
- Don't reintroduce a long run or quality session into week 1 silently. The renderer's floor is the baseline; the coach proposes on top with the athlete's buy-in.
- Don't touch the renderer, the preview, or the safe floor — those shipped. This is worker-only.

## Copy rules (athlete-facing, read daily)

Must not read as AI-generated. No sycophancy. Avoid the "That's not X. That's genuine Y." pattern. Avoid the words "genuinely," "honestly," "straightforward," "niggle." Follow the humanizer guidelines at https://github.com/blader/humanizer (the `humanizer` skill is available — run the new prompt copy through it). Match the existing Daybreak voice in `coach.md`.

## Tests + verification

- **Unit:** if you add the code-computed signal in `system-prompt.ts`, unit-test it the way `coachMode` is tested (`worker/__tests__` or wherever the system-prompt tests live) — ease-in active vs not (mid-week onboarder in week 1 = active; the same athlete in week 3 = inactive; a clamped far-race plan whose week 1 is in the future = inactive), days-left and runway values, and a "no residual `{{` placeholders" render-safety check for every mode. Keep the existing worker test suite green.
- **Live (the real check — no unit test exercises a Sonnet/coach run):** `fly deploy` the worker, then exercise a mid-week onboarder end to end on the staging group (`docs/testing-onboarding.md`): onboard partway through the week, then trigger the daily run (or tap `[Adjust it]`) and confirm the coaching message reasons about the remaining days × runway and frames week 2 as the first full week, in voice. Confirm a mid-plan (non-ease-in) run does **not** mention it.
- Run `npm run test`, `npm run typecheck`, `npm run lint` (`CLAUDE.md` §7) and report results.

## When done

Summarize what changed, show the before/after coaching message for a mid-week onboarder (long-remaining-week + short-runway vs short-remainder + long-runway), confirm the worker is deployed (`fly deploy`), and update `claude-status.md` per `CLAUDE.md` §8. If the safe-floor/adaptive-coach split warrants a spec body change beyond the v0.7.24 change-log entry, flag it for David rather than editing `SPEC.md` unilaterally (`CLAUDE.md` §2).
