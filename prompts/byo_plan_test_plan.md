# BYO-plan template — test plan

This is the validation work for `byo_plan_template.md` before Week 2 of the build wires the paste-back flow. Spend a half-day to a day on it; the deliverable is a v1 template that produces schema-valid, safe plans across the variety of athletes we expect.

The test plan does double duty: the safety-rule validator you write here becomes the v0 of the server-side validator in Prompt 11 of the Claude Code series.

## Setup

1. Save `byo_plan_template.md` in the new repo at `prompts/byo_plan_template.md`.
2. Create a spike workspace: `byo_plan_spike/results/`.
3. Write the v0 safety-rule validator (see "Automated checks" below) as `scripts/validate-plan.ts` in the new repo.

## Test profiles

Render the template with each profile's variables, paste into the LLM, run the test. Variables include a couple of bot-computed derivations (`longest_recent_x_1_5`); compute those at render time.

### Profile 1 — First-timer Annie

```
name: Annie
age: 32
sex: F
timezone: America/New_York
days_per_week: 5
hours_per_week: 8
goal_race_name: NYC Marathon
goal_race_date: 2026-11-01
distance_mi: 26.2
elevation_ft: 800
terrain: road
race_goal_description: Finish. No time goal — I just want to complete it.
tune_up_races_or_none: Brooklyn Half on 2026-05-16 (already completed — 2:14)
past_notable_or_none: Brooklyn Half 2:14, May 2026
freeform_meaning: Running is how I prove to myself I can do hard things. First marathon is a big deal.
injury_history_formatted: None reported.
freeform_anything_else: Travel for work 1 week in 4. Otherwise consistent.
recent_mileage_mi: 18
longest_recent_mi: 8
longest_recent_x_1_5: 12
asthma_note_if_present: (no asthma — omit this line)
```

### Profile 2 — Returning Rob

```
name: Rob
age: 45
sex: M
timezone: America/Chicago
days_per_week: 6
hours_per_week: 10
goal_race_name: Chicago Marathon
goal_race_date: 2026-10-11
distance_mi: 26.2
elevation_ft: 350
terrain: road
race_goal_description: Time — sub-3:45 (BQ for my age group).
tune_up_races_or_none: Chicago Half on 2026-09-13 (target sub-1:45)
past_notable_or_none: Chicago Marathon 3:52 in 2022
freeform_meaning: Getting back into shape after a few off years. Want to prove I've still got it.
injury_history_formatted: Right hamstring (severity 6/10, not active — tweaked it 6 months ago doing hill repeats, "feels fine now but I'm careful"); Left knee (severity 4/10, not active, occasional ache after long runs).
freeform_anything_else: Mild exercise-induced asthma in cold weather — usually fine with a warmup. Use rescue inhaler before hard winter sessions.
recent_mileage_mi: 25
longest_recent_mi: 12
longest_recent_x_1_5: 18
asthma_note_if_present: You have mild exercise-induced asthma — flag winter hard sessions where cold/dry conditions might trigger it, and surface the rescue-inhaler warmup pattern in the relevant weeks.
```

### Profile 3 — Trail Vet Tom

```
name: Tom
age: 43
sex: M
timezone: America/Los_Angeles
days_per_week: 5
hours_per_week: 8
goal_race_name: Headlands Trail Marathon
goal_race_date: 2026-08-30
distance_mi: 26.2
elevation_ft: 4000
terrain: trail
race_goal_description: Finish. Have done this one before; want to finish strong, no time goal.
tune_up_races_or_none: Broken Arrow 18k on 2026-06-19; Dipsea on 2026-06-14
past_notable_or_none: Headlands Trail Marathon 5:24, August 2025
freeform_meaning: Trails are where my head clears. I'm in this for the long haul, not chasing PRs.
injury_history_formatted: Left hamstring (severity 5/10, ACTIVE — proximal tendinopathy risk, current low-grade soreness); Calves bilateral (severity 4/10, not active, history of strains); Knees bilateral (severity 3/10, not active, occasional descent ache).
freeform_anything_else: Mild asthma, mostly fine on trail. Have a rescue inhaler. Live at sea level, race is at sea level.
recent_mileage_mi: 35
longest_recent_mi: 16
longest_recent_x_1_5: 24
asthma_note_if_present: You have mild asthma — generally fine in normal conditions, but flag any session where cold/dry/high-effort might combine.
```

### Profile 4 — Cold-start Carol

```
name: Carol
age: 50
sex: F
timezone: America/Denver
days_per_week: 4
hours_per_week: 6
goal_race_name: California International Marathon (CIM)
goal_race_date: 2026-12-06
distance_mi: 26.2
elevation_ft: 350
terrain: road
race_goal_description: Finish. First marathon ever. Birthday gift to myself.
tune_up_races_or_none: None planned yet — would welcome suggestions.
past_notable_or_none: 10k in 1:08, March 2026
freeform_meaning: I just turned 50 and want to do something hard.
injury_history_formatted: None reported.
freeform_anything_else: Started running 8 months ago. Consistent but conservative. Live at 5500 ft (Denver); race is at sea level.
recent_mileage_mi: 8
longest_recent_mi: 4
longest_recent_x_1_5: 6
asthma_note_if_present: (no asthma — omit this line)
```

### Profile 5 — Aggressive Alex

```
name: Alex
age: 28
sex: M
timezone: America/New_York
days_per_week: 6
hours_per_week: 12
goal_race_name: Marine Corps Marathon
goal_race_date: 2026-10-25
distance_mi: 26.2
elevation_ft: 700
terrain: road
race_goal_description: Time — sub-2:55 BQ.
tune_up_races_or_none: Philly Distance Run half on 2026-09-19 (target sub-1:23)
past_notable_or_none: NYC Marathon 3:08, November 2025
freeform_meaning: Marathon is my distance. Want to break 3:00 and BQ.
injury_history_formatted: Right ITB band (severity 4/10, not active, last flare 12 months ago after a fast 20-miler).
freeform_anything_else: No asthma. Strong runner, big aerobic base. Have done strength work consistently for 18 months.
recent_mileage_mi: 50
longest_recent_mi: 18
longest_recent_x_1_5: 27
asthma_note_if_present: (no asthma — omit this line)
```

These five cover the variation we expect: finish vs time, road vs trail, low base vs high base, no injuries vs active injury vs healed-history, conservative vs aggressive timeline.

## Models to test

Run each profile through all three:

1. **Claude Opus 4.6** — claude.ai with Opus selected (Pro tier).
2. **Claude Sonnet 4.6** — claude.ai default tier.
3. **ChatGPT default** — chat.openai.com on the default model.

That's 5 × 3 = **15 baseline runs**. Add at least one re-run per model on the same profile to check variance — pick Trail Vet Tom for the re-run, since he's closest to the real first user (David). Total: **18 runs**.

## Test procedure per run

1. Open a fresh chat in the target LLM. Do not reuse a session.
2. Paste the rendered template (variables substituted).
3. Read the LLM's opening reply.
4. **Do not iterate yet.** Capture the first-draft JSON between markers and save it as `byo_plan_spike/results/<profile>_<model>_v1.json`.
5. Run automated safety checks (below) against the saved JSON.
6. Score the manual rubric (below) based on the LLM's summary + the JSON.
7. **Then** iterate the conversation 2–3 turns with realistic athlete-side feedback — pick from this list to keep the iteration consistent across runs:
   - "The long runs ramp too fast in the first 4 weeks. Pull them back."
   - "I want more hill volume earlier."
   - "The cutback in week 8 doesn't feel like enough — drop it further."
   - "Add a strength session on Wednesday instead of an easy run."
8. After 2–3 iterations, ask the LLM "ship it." Save the final clean JSON as `<profile>_<model>_v_final.json`.
9. Re-score the iterated version against the same checks and rubric.

## Automated safety checks

Write `scripts/validate-plan.ts` to assert each of these on a loaded JSON file. Fail-fast with a clear message per violation. The script is the seed for the server-side validator in Prompt 11 — write it that way.

1. **Schema parse.** JSON parses cleanly + matches the schema structurally (use Zod).
2. **Long-run cap.** For every week: `max(day.distance_mi for day in days where type='long_run') <= 0.35 * planned_volume_mi`.
3. **Cold-start cap.** Week 1's longest day distance ≤ `1.5 * longest_recent_mi`.
4. **Volume ramp.** For any pair of consecutive non-cutback weeks within the same build phase: `weeks[i+1].planned_volume_mi <= 1.10 * weeks[i].planned_volume_mi`. One 15% jump per phase tolerated — flag for review rather than fail.
5. **Rest days.** Every week has at least one day with `type === 'rest'`.
6. **Hard-day spacing.** Across every rolling 7-day window: count days with `type` in `['hills','tempo','track','race']` plus long_runs with `intensity_rpe >= 7`. Assert ≤ 2.
7. **Cutback cadence.** Every 4th week is `phase === 'cutback'` AND its `planned_volume_mi` is 20–30% below the previous week.
8. **Taper structure.** The 3 weeks immediately before race week have `phase === 'taper'`, and their volumes are roughly 80% / 60% / 40% of the peak week volume (±10 percentage points tolerance).
9. **Timeline math.** `meta.start_date + (meta.total_weeks * 7) days` is within ±3 days of `meta.goal_race.date`.

A run passes automated checks if all nine pass, OR if only check 4 flags-without-failing. Track pass/fail per check, not just overall, so you know which rules to tighten in the prompt.

## Manual rubric (per run)

Score each criterion **pass / partial / fail**:

- **R1 — Phase structure** is appropriate for the timeline and goal type. (Finish-marathon with no peak weeks → fail; sub-3:00 plan with no quality work → fail.)
- **R2 — Long-run progression** is gradual and respects cutback weeks.
- **R3 — Injury accommodation** is visible in the plan. For profiles 2, 3, 5: does the plan explicitly handle the listed injuries in `key_notes` or day-level `notes`? (Tom's active hamstring → hills should build slowly with explicit eccentric-load progression; Alex's old ITB → bilateral strength + camber awareness.)
- **R4 — Race-specific reasoning** is present. Trail races have hill volume + explicit downhill exposure; road BQ plans have tempo + race-pace work; finish goals lean on time-on-feet.
- **R5 — Discussion quality** in the opening reply: did the LLM surface the right 1–2 risks for this athlete, ask a clarifying question if appropriate, or just produce generic output?
- **R6 — Tone** matches a coach you'd trust — specific, not over-confident, doesn't pretend to be medical.
- **R7 — Iteration responsiveness** (only for `v_final`): did the LLM meaningfully respond to the feedback, or just repeat itself with minor edits?

## Pass criteria

For the template to be ready for Week 2 of the build:

- **≥ 90% of first-draft runs** pass all automated checks (or only flag check 4).
- **≥ 80% of runs** score 5/7 or better on the manual rubric.
- **No catastrophic failures**: no plan violates a safety rule by >2× the cap; no plan ignores an active injury entirely; no plan misses the goal race date by more than 3 days.
- **Variance check:** the two Trail Vet Tom runs on the same model produce plans where total phase counts and peak weekly volume differ by ≤ 15%. If they don't, the prompt is under-specifying.

## Tracking sheet

A markdown table is fine. One row per run.

| Profile | Model | Run | Auto checks (X/9) | Manual rubric (X/7) | Notes |
|---|---|---|---|---|---|
| Annie | Opus 4.6 | v1 |  |  |  |
| Annie | Opus 4.6 | v_final |  |  |  |
| Annie | Sonnet 4.6 | v1 |  |  |  |
| Annie | Sonnet 4.6 | v_final |  |  |  |
| Annie | GPT-4o | v1 |  |  |  |
| Annie | GPT-4o | v_final |  |  |  |
| Rob | Opus 4.6 | v1 |  |  |  |
| ...etc | | | | | |
| Tom | Opus 4.6 | v1 (run 2) |  |  |  |
| Tom | Sonnet 4.6 | v1 (run 2) |  |  |  |
| Tom | GPT-4o | v1 (run 2) |  |  |  |

## Iteration loop on the prompt itself

After round 1 (18 runs scored):

1. Group failures by type (schema, safety rule, manual rubric, variance).
2. For each failure type with ≥3 occurrences, identify the cause: is the prompt under-specifying, contradicting itself, or relying on weaker model behavior?
3. Tighten the prompt for under-specifying issues. Examples of likely tightenings:
   - If models output prose inside the markers → add a literal sentence "the markers must contain only valid JSON, no markdown, no explanation."
   - If models routinely violate long-run cap → pre-compute a `max_long_run_at_peak` value in the bot and substitute it in the prompt as a hard number.
   - If models put hard days back-to-back → add a literal "Tuesday and Thursday are protected hard days; never schedule a hard effort on Wednesday, Friday, or Saturday."
4. Re-run only the failing subset. Repeat until pass criteria are met.

Budget: round 1 + 1–2 rounds of iteration ≈ 4–6 hours of wall time. Most is reading model outputs.

## What ships to Week 2

When the spike is done:

- Final `byo_plan_template.md` checked into the new repo at `prompts/byo_plan_template.md`.
- `scripts/validate-plan.ts` (the v0 safety-rule validator) at the new repo's `scripts/` directory — directly reused as the seed for the server-side validator in Claude Code Prompt 11.
- A short README at `byo_plan_spike/README.md` capturing:
  - Pass rates per model and per profile.
  - Known failure modes that survived iteration (so the bot's paste-back validation can surface useful errors).
  - The recommended "default LLM" to suggest to athletes — probably Opus 4.6 first, Sonnet 4.6 next, GPT-4o as a third choice.
  - Any prompt-template variables that needed adding during iteration (so the bot's renderer in Prompt 13 includes them).

## Side benefits of doing this spike now

- You arrive at Prompt 3 (schema migration) with a real, validated schema rather than a guess.
- You arrive at Prompt 11 (server-side plan-paste validator) with the validator already 80% written and known to work on real LLM outputs.
- You catch the worst prompt-engineering issues *before* any friend sees them.
- You generate ~18 real example plans you can show alpha friends as social proof during onboarding ("here's what other people's plans look like").
