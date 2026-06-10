# General Fitness (keep_fit) — deepening the no-race experience

**Status: draft, 2026-06-10. Not yet approved — no CHANGELOG entry, no SPEC.md §
rewrite. Workstreams here are designed to be picked up one prompt at a time;
each "Prompt" block below is sized to be a single scoped unit of work per the
CLAUDE.md working agreement.**

---

## 1. Why this exists

Daybreak started as a race-training companion, and General Fitness (`keep_fit` /
`goal_state = 'day_to_day'`) was routed in during onboarding v3 (W7, v0.7.23) as
an unblock, not a product. What a keep_fit athlete gets today is race coaching
with the race subtracted: the `base-maintenance` template plus four prompt
substitutions in `worker/system-prompt.ts` (coach title, mission line, goal
line, race-only known-gap suppression). Everything else — the daily-run shape,
post-activity notes, prehab, caps — is the shared race machinery.

The product case: most athletes race once a year. General Fitness is what keeps
them subscribed and engaged between races, and it's the funnel back into the
core race product. That makes two transitions (race → fitness, fitness → race)
load-bearing, and it makes the no-race daily experience worth designing on its
own terms rather than inheriting race framing.

## 2. Current state (verified 2026-06-10; GF-W1 shipped same day — see CHANGELOG v0.7.32)

- **Plan.** `base-maintenance` (`src/lib/plan-templates/templates/base-maintenance.ts`):
  open-ended base+build, cutback every 4 weeks, 35 mi peak cap, 14 mi long-run
  cap, one optional quality day (gentle tempo, build phase only), strides,
  strength combined with easy days, effort-led pace model. The renderer emits a
  **finite 8-week block** (`OPEN_ENDED_MAINTENANCE_WEEKS = 8` in
  `src/lib/plan-templates/renderer.ts`; intended-goal plans get 12).
- **Coach mode.** `coachMode()` in `worker/system-prompt.ts` returns
  `'no_race'` when `athlete_training_profile.goal_state === 'day_to_day'`.
  Substitutions: `coach_title` ("Running coach"), `missionLine` (consistency/
  base), `goalLine` ("Don't push toward a peak or nudge them to pick a race
  unless they raise it"), `targetTimeGapGuidance`, `knownGapsExamples`, and —
  since GF-W2 (v0.7.33) — `dailyStatusLead` (consistency story instead of
  on/off-track status) and `dailyNarrativeGuidance` (through-line variation +
  North-star tie-in).
- **Prod data caveat (found at GF-W2 build time, 2026-06-10).** Prod has zero
  `goal_state='day_to_day'` athletes. The one live keep_fit athlete (Anjie,
  v2-onboarded 2026-06-04) carries `goal_type='race'` /
  `goal_state='intended'` / `goal_distance='keep_fit'` + a stale
  `target_date` — a combo current v3 code can't produce. She coaches in
  `intended` mode and gets none of the no_race behavior until her row is
  fixed (see open question 6).
- **Everything downstream is shared:** "What a daily coaching run looks like"
  in `worker/prompts/coach.md` (status → today's workout → follow-ups → prehab
  → risk flags), the post-activity note, the plan propose/confirm flow
  (`worker/plan-version.ts` → `propose_plan_edit` RPC → athlete Yes/No tap).
- **GF-W1 shipped (2026-06-10, v0.7.32): open-ended plans now auto-extend.**
  At the top of each `daily_checkin` job, `extendPlanIfDue`
  (`src/server/plan/extend.ts`) appends the next rendered block when ≤ 14 dated
  days remain, auto-publishes via the `record_plan_extension` RPC (re-baselines),
  and the coach announces the block via `{{plan_extension_context}}`. Pure merge
  logic: `src/lib/plan-templates/continuation.ts`.
- **Race binding is deferred in both directions.** Fitness → race re-plan was
  deferred in v0.7.15 ("late race-binding re-plan" + `/setrace`); race →
  fitness rollover has never been specced.
- **Placeholder race.** PlanSchema requires `metadata.race`, so keep_fit plans
  carry a synthetic placeholder (selector `DISTANCE_MILES.keep_fit = 5`).
  Audited in GF-W1: the one leak (ICS calendar description) is fixed; the
  renderer now marks placeholders (`metadata.race.placeholder`, with
  `isPlaceholderRace` name-fallback for pre-flag plans).

## 3. Locks respected

Nothing here reopens a v1 scope lock or anti-goal:

- Telegram-only onboarding, Strava required, template-first plan-gen, the
  `job_queue` table, no Inngest — all untouched. New scheduled work rides the
  existing Vercel cron → `job_queue` → Fly worker path.
- The Sunday weekly survey stays off. GF-W6 (monthly recap) is a coach-written
  message on a monthly cadence, not a survey, and collects nothing.
- Wellness battery stays `/checkin`-only.
- The plan propose/confirm rule (coach proposes, athlete taps Yes) holds for
  every plan edit here, with one carve-out decided in GF-W1 (continuation of an
  exhausted plan — see the decision there).

## 4. Workstreams

Suggested order: **GF-W1 → GF-W2 → GF-W3 → GF-W4 → GF-W5 → GF-W6 → GF-W7.**
W1 is a fix; W2 is the cheapest visible improvement; W3+W4 are the strategic
transitions; W5–W7 deepen on top. Dependencies are noted per workstream — W2
and W5 are independent of everything and can be pulled forward; W7 wants W4
in place to have anything to nudge toward.

---

### GF-W1 — Open-ended plan extension (fix first) — **SHIPPED 2026-06-10 (v0.7.32)**

> Built as designed, with five build-time corrections recorded in the CHANGELOG
> entry: an `easeIn` render opt-out (the "falls out free" claim below was wrong
> — a future-Monday start DOES match the ease-in condition), strength-opt-out
> carry-forward from the working plan, stale-`target_date` nulling for intended
> athletes, plan-derived snapshot fallback when Strava is broken, and a David
> alert on extension failure. Decision (a) — auto-publish — confirmed.

**Problem.** A keep_fit athlete's plan ends after 8 weeks. At week 9 the plan
file has no future days, the subscribed calendar goes empty, `plan_drift.md`
has nothing to measure, and the daily message has nothing to prescribe against.
Intended-goal athletes hit the same wall at week 12 if no race ever binds.

**Design.** Deterministic, code-side extension — not coach-authored. The
renderer is the safety-validated path; asking the agent to hand-write 8 weeks
of one-line-per-day JSON via Edit calls is slow, expensive, and failure-prone.

Mechanics:

1. **Detection.** At the start of a `daily_checkin` job in the worker (before
   hydrate), if the athlete's `goal_state` is `day_to_day` (or `intended` with
   no bound race) and the active plan has ≤ 14 days of future dated days,
   trigger extension. Worker already imports from `src/` (`@/lib/db`,
   `@/server/agent/byo-plan`), so it can use `@/lib/plan-templates` and
   `@/server/strava/activities` directly.
2. **Render the continuation.** Re-run `selectPlan → renderPlan` with a fresh
   `getFitnessSnapshot` and `params.today` set to the Monday after the current
   plan's last dated day. Two properties fall out free: the snapshot reflects
   the trained-up athlete, so `startAnchor: 'strava_longest'` and the volume
   floors start the new block at current fitness, not at onboarding fitness;
   and a future-Monday start never matches the ease-in condition, so week 1 of
   the continuation is a normal week.
3. **Merge, don't replace.** Append the continuation's weeks onto the existing
   working plan JSON — renumber `week_number` continuing from the old block,
   keep the existing weeks untouched so past calendar events don't vanish
   (UIDs key on plan id; a version that dropped old weeks would delete them).
   Run `validateSafety` across the seam (old week 8 → new week 1 ramp); the
   continuation's own first week starts from current snapshot volume so the
   seam should pass — log a warning if it doesn't, same posture as
   `generateAndPersistPlan`.
4. **Publish.** Insert the merged plan as a new `plan_versions` row and repoint
   `plans.current_version_id`. Also repoint `baseline_version_id` to the same
   row: the old baseline's block is exhausted, and drift measured against it is
   meaningless once the plan is mostly continuation weeks. (This is the
   "re-baseline action" deferred in v0.7.11, scoped to extension only.)
5. **Tell the coach.** Add a context line to the daily prompt (same
   empty-substitution pattern as `{{ease_in_context}}`) on the run where the
   extension happened, so the morning message announces the new block in the
   coach's voice rather than the calendar just silently growing.

**Decision (recommend a):** (a) auto-publish the continuation — it's the
system keeping its promise of a rolling plan, not a coaching change, and an
empty calendar is strictly worse than an unconfirmed continuation; the athlete
can ask for changes in chat as always. (b) stage via `propose_plan_edit` and
require a Yes tap — consistent with the confirm rule, but a missed tap leaves
the athlete plan-less, which is the failure this workstream exists to remove.

**Also in this prompt — placeholder-race audit.** Grep every athlete-visible
surface (calendar render `src/lib/calendar-render.ts`, the web plan view, the
B1 preview formatting, the coach prompt's plan JSON exposure) for rendering of
the synthetic `metadata.race` on keep_fit plans. Fix any leak found (suppress
race lines for placeholder races — the renderer marks them; if it doesn't mark
them detectably, add a flag).

**Touches:** `worker/` (detection + a new `worker/plan-extend.ts` or similar,
prompt context line), `src/lib/plan-templates/` (a continuation entry point —
likely a thin wrapper, not renderer surgery), one new RPC or reuse of
`record_plan_edit` with repoint-baseline, calendar/preview audit. Deploy: Fly +
Vercel (push).

**Prompt grouping:** one prompt. Detection + render + merge + publish + prompt
line + audit are one coherent change; splitting them ships dead code.

---

### GF-W2 — No-race daily coaching narrative — **SHIPPED 2026-06-10 (v0.7.33)**

> Built with three build-time corrections (recorded in the CHANGELOG entry):
> two surgical placeholders (`{{daily_status_lead}}` for list item 1 +
> `{{daily_narrative_guidance}}` after the list) instead of forking the whole
> section — items 2–5 stay in coach.md once, shared; the runs-per-week target
> is NOT in the folder (days_per_week lives only in `athlete_training_profile`,
> never written to `athlete_profile.md`), so it renders into the prompt from
> the profile row with a plan-prescribed-days fallback; and the North-star
> pocket line is self-conditional in the prompt (the `known_gaps.md` idiom),
> not render-conditional — `renderSystemPrompt` doesn't load memory files.
> Also: the 7/28-day summaries are aggregates only (count/miles/minutes), so
> the lead instruction says how to derive the trend (7d vs 28d weekly average;
> long-run progression from the activities list). New review tool:
> `scripts/render-system-prompt.ts <email>` prints the rendered system prompt
> for one athlete, zero writes. **Reaches zero prod athletes until the Anjie
> data fix (open question 6) or GF-W3 creates day_to_day athletes.**

**Problem.** "What a daily coaching run looks like" in `coach.md` opens with
"on track, minor concern, or off track" — plan-compliance framing that means
little with no destination. For a keep_fit athlete the honest answer to "is
this working?" is a consistency and trend story, and the data is already in
the folder (`strava_recent.json` carries 7- and 28-day summaries;
`wellness_log.md` carries the trend).

**Design.** A `no_race` variant of the daily-run section, substituted the same
way W7 substituted the mission and goal lines — a new placeholder (e.g.
`{{daily_run_shape}}`) in `coach.md` rendered by `worker/system-prompt.ts`
from `coachMode`. The race/intended/unknown modes keep the current text
verbatim; `no_race` gets:

1. **Lead with the consistency story, not status.** One or two sentences read
   off the 7/28-day summaries: rolling volume trend, runs-per-week vs. their
   profile target, long-run progression. Pick the one thing that's most alive
   this week — don't recite all three every day.
2. Today's workout (unchanged mechanics — confirm/adjust, banked-session
   reconciliation carries over verbatim).
3. Open follow-ups, prehab, risk flags (unchanged).
4. **Vary the through-line week to week.** Explicit instruction that the
   repeated-message failure mode ("easy 4 today, keep it conversational" every
   day) is the thing to avoid: anchor different days to different threads —
   the long-run build, the strength habit, the wellness trend, the current
   focus block (GF-W5 once it exists).

**Pocket athletes.** If the athlete's memory carries a `North-star goal`
section (the W8 uncatalogued-goal pocket), the narrative should tie the
consistency story back to *their stated goal in their words*, not generic
fitness. One added instruction line, conditional on the section existing.

**Touches:** `worker/prompts/coach.md`, `worker/system-prompt.ts` (+ its
tests if any). No schema, no Vercel. Deploy: Fly only.

**Prompt grouping:** one prompt, and a small one. Good candidate to pull
forward — it's the cheapest visible improvement in the set.

---

### GF-W3 — Race → fitness rollover (post-race retention)

**Problem.** After a committed race the plan ends (post-race days are rested)
and nothing happens next. The athlete most likely to churn — just raced, no
new goal — gets silence. This is also the main acquisition channel for General
Fitness: every race athlete becomes a keep_fit candidate the day after their
race.

**Design.**

1. **Detection.** In `/api/cron/daily-checkin` (which already iterates
   onboarded athletes), flag athletes whose committed goal race date is N days
   past (recommend N = 3 — past the sore-legs window, before the habit dies)
   with no future race row and no rollover already offered. Track
   offered-state in `athlete_training_profile` (a nullable
   `rollover_offered_at` column, one migration) so the offer fires once.
2. **The offer.** Enqueue a `tg_message` job with a `trigger: 'race_rollover'`
   payload flag (the v0.7.22 pattern — payload flag, not a new job kind). The
   worker branches to a dedicated prompt: congratulate properly (the
   post-activity note already covered race day itself; this is the
   what's-next beat), reflect on the block in one or two lines from the files,
   then put the choice plainly: another race, or keep the fitness they just
   built. The message carries an inline keyboard — `[Pick a new race]`
   `[Keep me fit]` `[Let me think]` — using the existing outbound-keyboard
   path (`run-agent` already sends keyboards for plan confirms).
3. **`[Keep me fit]`** (bot-side callback): set `goal_state = 'day_to_day'`,
   clear `goal_race_id`, render a `base-maintenance` plan seeded from the
   fresh fitness snapshot (they're at peak fitness — the volume caps and a
   deliberate post-race down-week matter here; recommend the continuation
   render starts with a cutback-labeled week 1), persist with re-baseline,
   confirm in chat. Reuses the GF-W1 render-and-publish machinery — **W3
   depends on W1**.
4. **`[Pick a new race]`**: hand off to the GF-W4 binding path (or, until W4
   ships, to `/edit_profile` → Update something, which is live today).
5. **`[Let me think]`**: acknowledge, stop. The coach can re-raise once,
   conversationally, a week later (a line in the no_race/unknown daily prompt:
   if rollover was offered and unanswered for 7+ days, ask once more, then
   drop it). No third touch.

**Decision (recommend a):** (a) the post-race athlete's plan sits empty until
they tap — the offer IS the next step, and auto-generating a maintenance plan
they didn't ask for presumes the answer. (b) auto-roll into maintenance after
14 days of silence. Defensible, but it writes a plan to the calendar of
someone who may be done, and "calendar full of runs I never agreed to" is a
bad unsubscribe story.

**Touches:** cron route, one migration, `worker/poll.ts` dispatch branch +
a `worker/jobs/race-rollover.ts`, `worker/system-prompt.ts` prompt branch,
bot-side callback handlers, GF-W1's render/publish helper. Deploy: both.

**Prompt grouping:** one prompt, after W1. It's the largest single workstream
here; if it needs splitting, the seam is detection+offer (cron, job, prompt,
keyboard) in prompt one and the three callback paths in prompt two.

---

### GF-W4 — Fitness → race binding (the deferred re-plan, scoped)

**Problem.** When a keep_fit athlete decides to race, the product can't follow
them. The coach can write `race_calendar.md`, but no `races` row is created,
`goal_state` never changes, and the plan stays maintenance-shaped. This is the
exit ramp of the retention loop — deferred in v0.7.15, now load-bearing.

**Design.** Don't build a new conversational state machine. The v3
`/edit_profile` → "Update something" path already does Sonnet-parsed freeform
updates with inline confirms; the missing piece is what happens *after* a goal
update binds a race.

1. **Verify, then extend, the `/edit_profile` goal-update path.** The build
   agent should first read `src/server/telegram/onboarding/engine/` and the
   `/edit_profile` wiring to confirm what goal updates it supports today
   (race name/date via `lookupRace`, distance, target). Gaps found there
   (e.g. it updates the profile but can't create a `races` row) are in scope.
2. **Re-plan on binding.** When an update commits a new committed race
   (`goal_state` → `committed`, `races` row + `goal_race_id` set), trigger a
   re-render: `selectPlan → renderPlan` for the new distance × tier anchored
   on the race date (the v0.7.24 race-anchoring path), seeded from the current
   snapshot. Persist as a new version with re-baseline, show the B1-style
   preview, confirm. **Watch the idempotency guard:** `generateAndPersistPlan`
   reuses any active template plan (`getActiveTemplatePlan`) — the re-plan
   path needs an explicit regenerate that supersedes the maintenance plan
   rather than silently returning it.
3. **Coach-side detection.** A `coach.md` instruction (no_race + intended
   modes): when the athlete names a race they've actually entered, record it
   in `race_calendar.md` as today, then point them at `/edit_profile` to make
   it official — one line, with the plain statement that this is what
   regenerates their plan around the race. The coach never flips the goal
   state itself; it has no DB write and shouldn't.
4. **Mid-block sanity.** If the race is < 6 weeks out, the rendered plan will
   be short and sharp — that's the v0.7.24 allocator doing its job (drop
   phases from the front). No special handling; the preview shows what fits.

**Decision (recommend a):** (a) binding runs through `/edit_profile` only —
one consented, structured path; the coach funnels to it. (b) additionally let
the coach trigger binding via a structured marker in its output that the bot
parses. More magical, but it adds a fragile text protocol and a second write
path for the same state change. Not worth it at friend scale.

**Touches:** `src/server/telegram/onboarding/` (`/edit_profile` paths +
commit), `plan-gen.ts` (a `regeneratePlanForNewRace` alongside
`generateAndPersistPlan`), `coach.md` one instruction, maybe a `races` insert
helper. Deploy: both (mostly Vercel).

**Prompt grouping:** one prompt, with step 1 (read the existing engine) as the
agent's first task — the unknown here is how much of the update path already
exists, and the plan should be made after reading it, not before.

---

### GF-W5 — Monthly benchmark sessions

**Problem.** No race means no measurable progress, and "am I getting fitter?"
is the question a fitness product has to answer. A recurring benchmark gives
the keep_fit athlete a number that moves, gives the daily messages something
to build toward, and produces exactly the signal GF-W7's race nudge needs.

**Design.**

1. **The session.** A repeatable, self-administered check: 30 minutes at a
   steady "comfortably hard" effort (RPE 6–7), same route/terrain each time
   where possible, distance covered is the score. Effort-led (consistent with
   the keep_fit pace model — no target paces), low injury risk, works on
   trail. One per ~4 weeks.
2. **Template placement.** Add a `benchmark` workout to `base-maintenance`'s
   `workoutMenu` (dayType `tempo` with a benchmark-flagged description — no
   new DayType enum value needed) and place it once per 4-week cycle, on the
   quality day of the week *after* each cutback week (fresh legs, clean
   comparison). Renderer change is small: the microcycle already has a
   `quality` slot; the placement rule swaps it on the right week.
3. **The log.** `benchmark_log.md`, coach-authored on first benchmark
   completion, following the `prehab_program.md` pattern exactly (coach
   creates it if missing — no seeding, no schema change; `memory_files` rows
   are generic and `syncBack` picks up new files). One line per benchmark:
   date, distance, avg pace, conditions, one-line subjective note pulled from
   the athlete's post-run comment if they made one.
4. **Coach behavior** (`coach.md`, no_race section): the day before, frame it
   (what it is, that it's against their own last number, not a race); the day
   after it lands in `strava_recent.json`, assess vs. the previous entry —
   pace at effort drifting down is the win to name; flat is fine and should
   be said plainly ("held fitness through a heavy work month" is a result);
   log it. Never two benchmarks inside 3 weeks even if the athlete asks —
   caps posture: warn, confirm, comply.
5. **First benchmark.** The first one is a baseline, and the coach should say
   so — no comparison, no judgment, just the number that future ones beat.

**Dependency.** Wants GF-W1 (extension), because the benchmark cadence only
matters on a plan that doesn't end at week 8. Template change applies to new
renders and W1 continuations; existing athletes pick it up at their next
extension (no regen of live plans, consistent with v0.7.24's no-regen call).

**Touches:** `base-maintenance.ts`, renderer placement rule + tests,
`coach.md`. Deploy: both.

**Prompt grouping:** one prompt.

---

### GF-W6 — Monthly recap

**Problem.** Nothing ever zooms out. A no-race athlete's only artifacts are
daily messages; the proof that the product is working — a month of volume,
benchmark movement, wellness trend, prehab consistency — is sitting in the
files unassembled. This is the strongest single retention artifact for someone
with no race date pulling them forward.

**Design.**

1. **Trigger.** A monthly Vercel cron (first Sunday of the month, athlete-
   local morning is overkill — fire at the same 13:30 UTC slot, gated to
   first-Sunday) enqueues a `tg_message` with `trigger: 'monthly_recap'` per
   keep_fit athlete (recommend keep_fit-only at first; race athletes have the
   block structure doing this job). Payload-flag pattern again, no new job
   kind; reuses `agent_runs.kind = 'adhoc'` like post-activity does.
2. **The message** (worker prompt branch): a short recap, not a report — 6–10
   lines. Month's volume vs. prior month (28-day summaries + `checkin_log.md`
   history), longest run, benchmark delta if `benchmark_log.md` has two
   entries (GF-W5), wellness trend if `wellness_log.md` has enough rows,
   prehab consistency, one named focus for the coming month. Ends on a
   question, per the house style.
3. **Replaces the daily that day** — gate the daily enqueue for an athlete
   getting a recap (skip the `daily_checkin` enqueue for them that morning),
   so they don't get two messages. Cheapest at the cron, which enqueues both.
4. **Cost:** one extra agent run per athlete per month, minus one daily. Net
   ~zero against `agent_runs`.

**Dependency.** Standalone, but reads better with W5's benchmark log
available. Ship after W5 if both are happening.

**Touches:** `vercel.json` cron entry + a new or extended cron route,
`worker/poll.ts` branch + job module, `worker/system-prompt.ts` prompt branch.
Deploy: both.

**Prompt grouping:** one prompt. If GF-W5 hasn't shipped, build it anyway with
the benchmark line conditional on the file existing.

---

### GF-W7 — Earned race nudge (smallest, last)

**Problem.** The goal line currently reads "Don't push toward a peak or nudge
them to pick a race unless they raise it." Defensively right at launch, but it
forecloses the retention loop's re-entry. The fix isn't reversing it — it's
making the nudge *earned and rare*.

**Design.** Prompt-only.

1. Amend `goalLine` (no_race branch) in `worker/system-prompt.ts`: the coach
   may surface a race thought at most once per 6 weeks, only when the data
   supports it — a benchmark improvement (GF-W5), 8+ weeks of stable
   consistency, a volume base that would carry a 10K comfortably. Framed as an
   observation with an easy out ("no agenda — say the word if it ever sounds
   fun"), never a push, never repeated in the same thread.
2. Rate-limit state: a `Last race nudge: YYYY-MM-DD` line the coach maintains
   in `athlete_profile.md` (same write-durable-facts discipline already in
   `coach.md`). No schema, no new file.
3. If the athlete bites, the coach routes to the GF-W4 binding path —
   **depends on W4**; without it the nudge leads nowhere and shouldn't ship.

**Touches:** `worker/system-prompt.ts`, `coach.md` one paragraph. Deploy: Fly.

**Prompt grouping:** fold into the same prompt as a GF-W4 follow-up or any
other Fly-only prompt (W2 is the natural host if W4 is already live).

---

## 5. Explicitly out of scope (named, not forgotten)

- **A true-beginner path.** `base-maintenance` floors at 12 mi/week across a
  3-day minimum microcycle — that's a runner, not a beginner. A run/walk
  couch-to-5k tier is a real product question (different template family,
  different safety model, possibly different audience) and should be its own
  spec if the friend cohort ever surfaces the need.
- **Ultra/pocket graduation.** `ULTRA_SUPPORT.md` U1 owns it. GF-W2's
  North-star-goal narrative line is the only contact point.
- **Drift threshold / off-track alerts** — still deferred (v0.7.11), and
  GF-W1's re-baseline-on-extension reduces how much drift accumulates for
  keep_fit athletes anyway.
- **Unbounded plan growth (named at GF-W1 ship time).** Each extension appends
  8 weeks (~every 6 weeks of wall time), so the working plan JSON grows without
  bound — coach context, ICS size, and hydrate cost creep. Fine at friend scale
  for a year-plus; pruning old weeks tensions with keeping past calendar events
  (UIDs key on week numbers). Revisit when a plan passes ~40 weeks.
- **Per-athlete-local recap/daily timing** — same deferral as the daily cron.
- **The eval harness (V3-W5)** is unaffected, but note: W2's prompt changes
  are exactly the kind of `coach.md` edit the v0.7.19 coaching-quality harness
  was specced to regression-test. Building W2 without it means David-reads-
  the-messages-table review, same as today.

## 6. Open questions for David

1. ~~**GF-W1 decision** — auto-publish continuations (recommended) or
   propose/confirm?~~ **Decided 2026-06-10: auto-publish. Shipped.**
2. **GF-W3 decision** — offer-and-wait after a race (recommended) or
   auto-roll to maintenance after 14 days of silence?
3. **GF-W4 decision** — binding through `/edit_profile` only (recommended) or
   also a coach-output marker protocol?
4. **GF-W6 scope** — keep_fit-only recaps (recommended) or all athletes?
5. **Benchmark shape** — 30-min steady effort is the recommendation
   (trail-friendly, effort-led); a mile time trial is the sharper signal but
   needs a track/flat road and reads more race-like than the audience wants.
   Worth a gut check against the actual friend cohort.
6. **Anjie's profile row (found at GF-W2 build time)** — she's the only live
   keep_fit athlete, but her v2-era row reads `goal_type='race'` /
   `goal_state='intended'` / `goal_distance='keep_fit'` with a stale
   `target_date` (2026-07-30), so she coaches in `intended` mode ("a race in
   mind — no race picked yet") and never sees the no_race behavior (W7's or
   W2's). Recommended fix: one-row update to `goal_type='day_to_day'`,
   `goal_state='day_to_day'`, `target_date=null` — matching what v3 onboarding
   would have written. Alternative (not recommended): broaden `coachMode()` to
   treat `goal_distance='keep_fit'` as no_race regardless of `goal_state`,
   which papers over inconsistent data with a second source of truth.

## 7. Sequencing summary

| Order | Workstream | Size | Deploy | Depends on |
|-------|-----------|------|--------|------------|
| 1 | ~~GF-W1 extension + placeholder audit~~ **shipped v0.7.32** | M | Fly + Vercel | — |
| 2 | ~~GF-W2 daily narrative~~ **shipped v0.7.33** | S | Fly | — |
| 3 | GF-W3 race → fitness rollover | L | both | W1 |
| 4 | GF-W4 fitness → race binding | M–L | both | — |
| 5 | GF-W5 benchmarks | M | both | W1 |
| 6 | GF-W6 monthly recap | M | both | (W5 soft) |
| 7 | GF-W7 race nudge | XS | Fly | W4, W5 |

Each row is one prompt except W3, which has a named split seam if it runs
long. When a workstream ships, record it in `Specs/CHANGELOG.md` per the
source-of-truth convention and update §2 of this file to the new reality.
