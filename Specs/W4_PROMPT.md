# W4 kickoff prompt — onboarding v2: plan preview + adjust loop

> Paste this into a fresh session to start W4. (Delete or commit this file as you like — it's just a handoff note.)

---

Kick off onboarding v2 — W4: wire the W3 template plan-gen engine into the live
onboarding flow (the B1 plan preview + the `[Looks good]` / `[Adjust it]` loop +
next-actions). W3 is built and deployed: `selectPlan → renderPlan` produces a
PlanSchema-valid, safety-checked `Plan` for all six templates × three goal states.
W4 makes it real in Telegram. Suggest improvements as you read, but don't
relitigate the locked W3 decisions.

READ FIRST (source of truth, in order):
1. Specs/SPEC.md — change-log v0.7.10 (what shipped in W3) + v0.7.8/v0.7.9 (the
   template-first + onboarding-v2 decisions), then §3.4 (plan-gen, now
   template-first) and §3.9 (onboarding state machine).
2. Specs/ONBOARDING_V2.md — W4 (preview + adjust loop + next-actions) and the B1
   preview copy in Part 1 (the two variants: committed-race and intended-no-date),
   plus where B1 inserts in the state machine.
3. claude-status.md — the session-26 "W3 plan-gen engine BUILT" entry and the
   "Likely next task" section (W4 + the snapshot-adapter prerequisite).
4. The W3 engine you're wiring in: src/lib/plan-templates/ — `selectPlan`,
   `renderPlan`, `validateSafety`, the `SelectorProfile` / `FitnessSnapshotInput`
   inputs (selector.ts), and `RenderParams` (esp. `timeGoalDiscouraged`,
   `strengthSessionsPerWeek`, `overlays`, `totalWeeks: null` for open-ended).
5. The wiring targets: src/server/telegram/onboarding/ (state machine + steps),
   src/server/strava/activities.ts (`getFitnessSnapshot` →
   `StravaFitnessSnapshot`), the `plan_versions` + `memory_files` tables/schema,
   the `job_queue` enqueue helper, and how the worker hydrates the athlete folder
   (it reads `marathon_training_plan.json`).

BUILD, IN ORDER:
1. **Snapshot adapter (the W3-flagged prerequisite).** `getFitnessSnapshot` returns
   snake_case `StravaFitnessSnapshot`; the selector consumes camelCase
   `FitnessSnapshotInput`. Write the adapter at the wiring boundary (snake→camel),
   and a `buildSelectorProfile()` that maps `athlete_training_profile` + the goal
   race row → `SelectorProfile` (experienceTier, goalDistance, daysPerWeek,
   longRunDay, goalState, targetDate, targetType, targetTimeSec, race, injuries,
   today in the athlete's tz). Unit-test both.
2. **Generate + persist.** After onboarding has the data to render (goal +
   distance + experience + days + long-run day + Strava/recent-mileage), call
   `selectPlan → renderPlan`. Persist the rendered plan BOTH as a `plan_versions`
   row (status active; pick/confirm a `generated_by` value — add an enum value if
   needed via migration) AND into the athlete's memory files as
   `marathon_training_plan.json` so the worker coach reads it. Deterministic, inline
   on the bot path — no LLM, instant.
3. **B1 preview message.** Render the "here's your starting plan…" summary from the
   `Plan` (weeks, start→peak volume, long-run day, peak long run; for open-ended:
   "no race locked — base+build, taper deferred"). Two variants per ONBOARDING_V2
   (committed vs intended-no-date). Surface the assumptions out loud. Inline
   keyboard: `[Looks good]` / `[Adjust it]`. If `params.timeGoalDiscouraged`, add
   the gentle nudge. Offer the strength opt-out (strength is 0–2 ADDITIONAL
   sessions; opt-out → re-render with `strengthSessionsPerWeek = 0`).
4. **Routing.** `[Looks good]` → confirm, finish onboarding, fire the David alert
   (src/server/admin/alerts.ts). `[Adjust it]` → enqueue a worker `tg_message`-style
   job seeded "athlete wants to adjust the just-generated plan"; the coach
   customizes on top of the rendered plan (it never regenerates on the bot path).
   Then next-actions (Add to calendar / Adjust / Done) per ONBOARDING_V2.
5. **Tests** for the adapter, profile-builder, preview rendering (both variants +
   discouraged-time-goal + open-ended), and the callback routing. Keep
   typecheck/lint/tests green.

HARD CONSTRAINTS / DECISIONS (don't relitigate):
- Telegram-only onboarding; no web onboarding routes.
- Template-first is the default; BYO stays deferred. The renderer is
  deterministic and runs inline (instant preview). The worker agent only
  customizes via `[Adjust it]`.
- `days_per_week` = RUN days; strength is additional, opt-out-able, bodyweight
  until the `strength_equipment` known gap is filled (W5).
- Caps are advisory (warn + confirm + comply, never refuse) — already enforced in
  the rendered plan's `agent_guidance` and the worker coach prompt; don't re-add.
- The agent never edits an existing `plan_versions` row; modifications create a
  new version (`supersedes_id`). The `plan_change_proposal` 👍/👎 flow stays
  deferred.
- Follow CLAUDE.md working agreement: re-read the relevant SPEC/ONBOARDING_V2
  section first, no new libraries, no scope creep.

DONE WHEN: a finished onboarding renders a plan, persists it (plan_versions +
marathon_training_plan.json), shows the B1 preview with working `[Looks good]` /
`[Adjust it]`; `[Adjust it]` reaches the worker coach with the plan in context;
typecheck/lint/tests green; SPEC §3.9 + change-log + claude-status updated.

CONTEXT FROM W3 (worth knowing):
- The long-run curve and taper were tuned at the end of W3 (long run stretches
  across base/build and holds at the ceiling through peak; taper keeps one short
  sharpener). No outstanding plan-shape issues.
- `computeRenderParams` takes the resolved template as a 4th arg (selectPlan
  handles this).
- No-race plans synthesize a placeholder `metadata.race` (PlanSchema requires it)
  and render a finite base+build block (12 wk intended / 8 wk maintenance) — the
  preview should frame these as open-ended with the taper deferred.
