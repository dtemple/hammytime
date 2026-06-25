# Ultra support — race distances beyond the marathon

_Status: proposal, unscheduled. First pass 2026-06-05 after the Western States transcript; second pass later the same day, after a second live transcript (Chase, 44-mile non-race mountain run) and a triage conversation. The second pass moves the intake-side failure handling into `ONBOARDING_V3.md` (V3-W8: the uncatalogued-goal pocket + deterministic bucket derivation) and the two engine bug fixes into `Specs/V3_HARDENING_PROMPT.md` — this doc now owns **catalog and plan-gen expansion**: buckets, templates, caps, the renderer, non-race events, and the volume-goals analysis. `SPEC.md`/`CLAUDE.md` stay untouched until David signs off and a workstream is scheduled (the `ONBOARDING_V3.md` convention)._

_**v4 reconciliation (2026-06-24).** `Specs/ONBOARDING_V4.md` (signed off) adopts this doc's catalog scope as **v4-W4**: **U1 is locked as v1 catalog scope** (the four buckets, `ultra-50k`, distance-derived plausibility, widened bands, non-race adventures / `event_kind`) and **U2 (50mi+ renderer work: back-to-back long runs, time-on-feet) is deferred** with the §6 pointer. v4 owns the event *framing* + the no-event off-ramp; this doc keeps owning catalog + plan-gen. The `event_kind` column and the §3.5 athlete-stated adventure fill land with W4 (the v4-W1 framing slice shipped without them, v0.7.40)._

_**U1 catalog slice LANDED (V4-W4, 2026-06-24, v0.7.46 — the authoritative record).** Two David decisions amend this doc's design:_
- _**Lean enum — only `50k` is a real bucket.** `50mi/100k/100mi` are NOT added to the enum (a total-record `SELECTION_TABLE`/caps would force them to map to a template that doesn't exist until U2; the §3.2 ultra fallback rows never fire because 50mi+ always carries a concrete distance → the pace envelope). So §2.2/§3.1's "four granular buckets" is **`50k`-only** in v1; the `50mi/100k/100mi` archetypes stay conceptual until U2. `deriveBucketFromMiles` tops at the 50k band (28–40mi); the §3.2 envelope + a single `50k` fallback row shipped; the `ultra-50k` template (§3.4) shipped with `time_goal` suppressed and DRAFT caps (long-run 26, peak ~60) **David-confirmed**._
- _**Beyond-50k OFF-RAMPS — no consented proxy.** §3.1/§3.4's "a 44-miler selects the 50mi archetype" and "proxy with consent" for 50mi+ is **superseded**: a goal past the 50k is acknowledged, the 50k ceiling stated, and the athlete asked for a shorter event/tune-up to build around — no proxy plan, no future-plan promise. The intake pocket's long-side marathon-proxy is retained-but-unrouted (revivable). The short-side 5k proxy is unchanged._

_**W4b LANDED (2026-06-25, v0.7.47):** `races.event_kind` + the §3.5 athlete-stated adventure fill (non-race goal + fuzzy dates) + the recap `event_kind` line — see the §3.5 status note for the two refinements (model `event_kind` signal; `not_found` disambiguation; mid-month ISO date). The only remaining U1 rider is the worker race-week "your run" tone touch (step 15) — cosmetic, deferred._

---

## 1. What the live tests showed

The first transcript (`transcripts/davidjtemple_gmail.com.md`) reads as the bot being confused about whether Western States is a marathon. It wasn't confusion — the schema has no way to store the truth.

`goal_distance` is a closed enum, `'5k' | '10k' | 'half' | 'marathon' | 'keep_fit'`, in three places: the v3 slot type (`src/server/telegram/onboarding/slots/schema.ts` `GoalDistanceValue`), the DB CHECK (`supabase/migrations/20260601000000_athlete_training_profile.sql`), and the extractor prompt's `ENUM_RULES` block (`engine/extract-and-advance.ts`), whose own comment warns that a non-literal value "is silently dropped, which strands a required slot and loops the flow."

The sequence:

1. `lookupRace` did its job — returned Western States with `distance_mi: 100`. The lookup layer is distance-agnostic and needs no change.
2. The extractor had no legal `goal_distance` value for a 100-miler, so it wrote `marathon` as the nearest literal (provenance `inferred`).
3. Sonnet's own reasoning kept colliding with the stored value — "Wait — Western States is 100 miles, not a marathon" — but each correction had nowhere to land.
4. After the recap, the `firstUnconfirmedInferred` guardrail (`engine/guardrails.ts`) correctly refused to generate on an unconfirmed inferred plan-driving slot and fired the deterministic fallback: "Quick check — I've got your distance as marathon. Right?"
5. "Fix it" → "Ultra" → the extraction was dropped (no matching literal) → the slot stayed `marathon`, unconfirmed → loop.

The guardrails worked as designed; the enum starved them.

**The second transcript, same day** (`transcripts/chaseheaton_gmail.com.md`): Chase named three goals in his first message — Broken Arrow 18K (looked up cleanly), Double Dipsea, and a 44-mile non-race adventure run (Rae Lakes Loop, September) — and the extractor caught all three. Then the same enum wedge on the 44-miler, plus two engine bugs the wedge exposed (a deterministic confirm that repeated seven times against seven "Looks right" replies, and Broken Arrow's date silently surviving onto the Rae Lakes goal). Those two are bug fixes against the v3 engine, specced in `Specs/V3_HARDENING_PROMPT.md` and recorded in `ONBOARDING_V3.md` §1.2 — not part of this doc. Two more things the Chase transcript established for *this* doc: the goal can be a **non-race** (no lookup hit, no official date — §3.5), and an off-catalog distance caused zero problems **as a tune-up**, because `tune_up_races` stores name + date freeform with no bucket. Evidence that bucket-free storage works wherever structure doesn't need it.

**Division of labor after the second pass:** the v3 engine learns to *fail honestly* on goals the catalog can't structure (the pocket, V3-W8 — acknowledge, proxy with consent, store the athlete's words) regardless of what this doc ships. This doc grows the catalog underneath that pocket, so goals graduate from "honest boundary" to "fully structured plan."

---

## 2. The two questions

### 2.1 Can the agent adapt marathon plans, or do ultras need their own templates?

Both, split by distance. The template library's design premise is that distance is the structural axis — "you can't scale a 5k into a marathon" (`src/lib/plan-templates/types.ts` header). The same holds going up, with one exception: a 50k is structurally a long trail marathon and can ride the existing machinery with a thin new template. 50mi and beyond cannot.

Why agent-side adaptation of marathon templates is not a path, even as a stopgap:

- **The selector can't run.** `SELECTION_TABLE` is `Record<GoalDistance, Record<ExperienceTier, TemplateId>>` — a total record. There is no ultra row to select from; the enum change forces code changes regardless, so "let the agent stretch a marathon plan" was never the cheaper option.
- **The first impression is wrong.** The renderer builds within template caps — marathon long run tops out at 22 mi, peak week at 55 mi (`marathon-performance`). The B1 preview, the athlete's payoff moment, would show a marathon-shaped plan for their 100-miler.
- **The guidance would fight the goal.** Caps flow into the rendered plan's `agent_guidance.compliance_rules` and the worker coach prompt (one source of truth, by design — `caps.ts` header). The daily coach would warn-and-confirm against exactly the volume the race requires, on every edit, indefinitely. Caps are advisory, so the coach *could* be argued past them — but every ultra athlete's plan would start wrong and get negotiated into shape against guidance calling it risky.
- **Structure the templates can't express.** Microcycles allow exactly one `long_run` role per week (`MicrocyclePattern`); 50mi+ training is built on back-to-back long runs. Time-on-feet prescriptions, hiking as a session goal, and fueling progressions as a first-class progression (not a note) have no template-level representation.

What already works, and stays untouched:

- **The plan schema is closer to ultra-ready than expected.** `power_hike_note`/`power_hike_practice`, `nutrition_note`/`nutrition_practice`, `elevation_gain_ft`, the trail overlay, and the effort-led pace model all exist — inherited from the canonical plan. The schema needs no structural change for U1 and only minor additions for U2 (§3.6).
- **The daily coaching loop adapts fine.** The worker agent reads the plan JSON and Strava data; almost nothing in `coach.md` is marathon-specific beyond framing copy and the (cosmetic) `marathon_training_plan.json` filename. A correct ultra plan in the folder gets coached correctly today.
- **`races.distance_mi` is numeric** and `lookupRace`, `race_calendar.md`, and `tune_up_races` carry any distance. A 50k tune-up inside a 100-mile block — or Chase's 18K inside a 44-mile block — works with no changes.

### 2.2 Do enum values need to change?

Yes, and the enum is the root cause of both observed failures (§1). The full inventory is §4. The headline: `goal_distance` gains four granular buckets — `'50k' | '50mi' | '100k' | '100mi'` (decision #1, §8) — because three consumers key off the bucket and need different values per distance: finish-time plausibility, long-run caps, and template selection.

**The bucket is a training-structure archetype, not the athlete-visible race distance** (decision #5, §8). The exact distance lives in `races.distance_mi` and flows into the plan's `metadata.race.distance_miles`, the race-day entry, and everything the athlete reads. A 44-miler maps to the `50mi` bucket *internally* — selecting the 50-mile training structure — while the plan says "Rae Lakes Loop, 44 miles" on race day. Nobody is ever told "I'm rounding you to 50"; there is nothing to round. The earlier idea of having the agent announce a rounding turns out to be the same design with worse copy.

No quick-question chip layout changes: the distance question has more than 3 options already, so per v3 principle 2 it stays freeform with model-optional chips — only the `ENUM_RULES` literal list grows.

---

## 3. Design

### 3.1 Bucket derivation — mechanism in v3, bands widened here

The derivation mechanism — a confirmed race's `distance_mi` sets `goal_distance` in code, never by model choice, with out-of-range routing to the pocket — **ships with v3 (V3-W8, `ONBOARDING_V3.md` §5.3) against the current catalog**. U1's job here is to widen the bands so the four ultra buckets resolve instead of pocketing:

| `distance_mi` | bucket |
|---|---|
| < 8 | `5k`/`10k` by nearest |
| 8 – 17 | `half` |
| 17 – 28 | `marathon` |
| 28 – 40 | `50k` |
| 40 – 55 | `50mi` |
| 55 – 75 | `100k` |
| > 75 | `100mi` |

Bands are deliberately wide — trail races run long, a 28-mile "marathon" trains like a 50k, and Chase's 44-miler resolves to the `50mi` archetype without a conversation about it. With U1 landed, coverage is total for any positive distance; the pocket then only catches goal *shapes* the catalog can't hold (multi-day formats, volume goals until they ship), not distances.

### 3.2 Finish-time plausibility — distance-derived (supersedes the first-pass bucket table)

Decision #7 (§8): the plausibility window is computed from `distance_mi` when a concrete distance exists, replacing per-bucket table entries. A pace envelope generalizes to any distance in one expression — DRAFT bounds: **floor ~3:50/mi, ceiling ~25:00/mi**, which reproduces the existing hand-tuned 5k–marathon windows within tolerance and extends to a 44-miler or a 100k without new table rows. The existing `FINISH_TIME_RANGES_SEC` table stays only as the fallback for bucket-only goals (the intended branch, where no concrete distance exists yet), gaining the four ultra rows for that case:

| bucket | min | max |
|---|---|---|
| `50k` | 3:00 | 12:00 |
| `50mi` | 5:00 | 18:00 |
| `100k` | 6:00 | 24:00 |
| `100mi` | 11:00 | 48:00 |

The `target_time` slot's `NumericSpec.plausibleRange.max` rises from 8h to 48h — it's the pre-distance catch-all; the derived window does the tight check. Without this, "sub-24" for a 100 gets rejected as implausible and loops the disambiguation.

### 3.3 Safety caps

`maxLongRunMiByDistance` additions (DRAFT — these move with David's review, same as the W3 cap decision):

- `50k`: 26 — a marathon-distance long run is the ceiling for this bucket.
- `50mi`: 28, `100k`: 30, `100mi`: 32 — single-run ceilings stay modest on purpose; 50mi+ training leans on cumulative weekend fatigue, not single monster runs.
- New cap field for U2: `maxBackToBackTotalMi` (DRAFT 40) — once back-to-back long runs exist, the weekend *total* is the load-bearing limit and the single-run cap is secondary.

The advisory posture is unchanged: renderer builds within caps; the coach warns-and-confirms past them, never refuses.

### 3.4 Templates

**`ultra-50k` (U1 — no renderer changes needed).** Marathon-performance skeleton with: distances `['50k']`, effort-led pace model (no Riegel pace derivation — trail paces don't map), long-run cap 26, peak volume cap ~60 (DRAFT), `nutrition_practice` flagged on long runs from mid-build, trail overlay effectively default (most 50ks are trail; the existing `deriveTerrain` handles it). `time_goal` overlay **suppressed** — a stated target is recorded as race-strategy reference, not a pace driver (revisit if real athletes want pace-led 50k blocks).

**`ultra-endurance` (U2 — needs renderer features).** Distances `['50mi', '100k', '100mi']`, with volume bands keyed by bucket inside the one template (the same pattern as `short-race` spanning 5k/10k via params). Structure: back-to-back weekend long runs through build and peak, time-on-feet as the long-run unit in peak weeks, `power_hike_practice` progression, mandatory fueling progression, 2–3 week taper. `time_goal` suppressed. Night-run practice and vert targeting are out of scope (§7).

`SELECTION_TABLE` rows (total record, every tier filled):

| | beginner | for_fun | some_training | experienced |
|---|---|---|---|---|
| `50k` | ultra-50k | ultra-50k | ultra-50k | ultra-50k |
| `50mi`/`100k`/`100mi` | ultra-endurance | ultra-endurance | ultra-endurance | ultra-endurance |

Tier feeds volume params as elsewhere. There is no hard tier gate (decision #3, §8): a beginner naming a 100-miler selects the template, but the intake surfaces it through the existing §5.1 safety-contradiction mechanism — Chase's actual profile (15 mi/wk, 3 days, long-standing ITB, 44 mountain miles ~14 weeks out) is now the fixture for exactly this. A direct conversation before plan-gen, not a wall. Consistent with caps-are-advisory.

### 3.5 Non-race events (U1 rider)

_**LANDED (V4-W4b, 2026-06-25, v0.7.47).** Built largely as written, with two refinements: detection is a model `event_kind` signal on `extract_and_advance` (a self-set bare-distance run never hits the lookup, so a failed-lookup-only hook couldn't tag it), not only a `not_found` reinterpretation; and the `not_found` path **disambiguates** ("organized race, or your own thing?") rather than silently filling, so an obscure-but-real race isn't mislabeled. The fuzzy date resolves to a **mid-month ISO date (the 15th)**, not a non-ISO placeholder — `races.date` / `target_date` are `date` columns and reject non-ISO. The ceiling holds: a >40mi adventure off-ramps (reuses W4's `applyUltraOffRamp`), it does not proxy._

Rae Lakes is the type case: a named route, a real distance, "September," a friend — and not a race. No lookup hit, no official date. Today the only homes are `committed` (requires a looked-up race) or `intended` (distance + placeholder, loses the name and specifics). The fix is small because the `races` table never required officialness — it's name/date/distance:

- **Athlete-stated fill.** When the athlete describes a personal objective, the model flags `event_kind: adventure` and fills `goal_race` from their words; the engine skips the lookup and fills the rest — provenance `stated`, one inline confirm. (For a named-but-unfound query the `not_found` branch asks which it is and pre-fills the name.) The stated distance rides to the row as the real `distance_mi` via `event_distance_mi`.
- **Fuzzy-date resolution.** "September" → ask once ("got a specific day, or just sometime in September?"); a month-only answer takes the **15th** of that month (a valid future ISO date the past-date guard passes). The plan builds toward it; the coach firms it up when the athlete does.
- **`event_kind: race | adventure`** on the `races` row (default `race`) so the recap says "your run" instead of "your race." The coach reads it from `race_calendar.md` context; the worker race-week tone touch (step 15) stays deferred (cosmetic, a `fly deploy`).

### 3.6 Renderer changes (U2 only)

U1 requires none. U2 needs two capabilities:

1. **Back-to-back long runs.** A new run role (`long_run_b2b`) placeable adjacent to the long-run day in a microcycle, with its own progression line and the `maxBackToBackTotalMi` cap. This is the substantive renderer work and the reason 50mi+ is its own phase.
2. **Time-on-feet long runs.** Peak-week long runs prescribed in hours rather than miles. Smallest viable shape: a `planned_duration_min` on a `long_run` day (the field exists for strength days) plus description copy — no new schema type.

### 3.7 Copy and prompt changes

- `ENUM_RULES` in `extract-and-advance.ts`: extend the `goal_distance` literal list.
- The engine system prompt's "marathon coaching app" → "running coaching app".
- `guardrails.ts` `DISTANCE_LABELS`: add the four labels ("50k", "50-miler", "100k", "100-miler").
- `worker/prompts/coach.md`: a short ultra note (expect higher volume, hiking is training, fueling is a session goal — don't read a 60-mile week as an anomaly). The `marathon_training_plan.json` filename is a memory_files key rename and stays as-is (cosmetic).
- v2's `parsing/distance.ts` `ultra → 50` alias is the legacy path; v3 cutover makes it dead. Leave it.

---

## 4. Change inventory

| # | File | Change | Phase |
|---|---|---|---|
| 1 | `slots/schema.ts` | `GoalDistanceValue` + 4 literals; ultra rows in the fallback `FINISH_TIME_RANGES_SEC`; `target_time` envelope → 48h | U1 |
| 2 | new migration | extend `athlete_training_profile.goal_distance` CHECK; `races.event_kind` column (§3.5) | U1 |
| 3 | `engine/extract-and-advance.ts` | `ENUM_RULES` literals; system-prompt framing; non-race athlete-stated fill rules (§3.5) | U1 |
| 4 | engine derivation (V3-W8) | **mechanism ships with v3** (`ONBOARDING_V3.md` §5.3); U1 widens the bands (§3.1) | V3-W8 → U1 |
| 5 | `engine/guardrails.ts` | `DISTANCE_LABELS`; goal_distance enum set | U1 |
| 6 | `engine/numeric.ts` | distance-derived plausibility window from `distance_mi` (§3.2) | U1 |
| 7 | `plan-templates/types.ts` | `GoalDistance` + 4 literals; (U2) `maxBackToBackTotalMi` cap field | U1/U2 |
| 8 | `plan-templates/selector.ts` | `SELECTION_TABLE` rows; `DISTANCE_MILES` (31.1 / 50 / 62.1 / 100) | U1 |
| 9 | `plan-templates/caps.ts` | `maxLongRunMiByDistance` entries (§3.3) | U1 |
| 10 | `plan-templates/templates/ultra-50k.ts` | new template (§3.4) | U1 |
| 11 | `plan-templates/templates/ultra-endurance.ts` | new template (§3.4) | U2 |
| 12 | `plan-templates/renderer.ts` | back-to-back role; time-on-feet long runs | U2 |
| 13 | `engine/commit.ts` + fuzzy dates | non-race events: athlete-stated race row, `event_kind`, month-only placeholder (§3.5) | U1 |
| 14 | engine contradiction prompt | beginner/for_fun × 50mi+ named as a contradiction example | U1 |
| 15 | `worker/prompts/coach.md` | ultra framing note; "your run" tone for `event_kind: adventure` | U1 |
| 16 | tests / eval | template render tests; v3 fixtures already added (`ONBOARDING_V3.md` §7): out-of-catalog goal, bucket derivation, non-race goal, Chase contradiction profile | U1/U2 |

TypeScript does most of the enforcement: the total `Record<GoalDistance, …>` types break the build until items 8–9 and every other consumer are updated, so the enum change can't land half-done.

---

## 5. Proposed phasing (unscheduled)

- **Pre-U1 (lives in v3, not here):** the hardening fixes (`Specs/V3_HARDENING_PROMPT.md`) and V3-W8 (pocket + derivation mechanism). After these, an off-catalog goal degrades to an honest conversation instead of a loop — U1 stops being urgent and becomes pure catalog growth.
- **U1 — enum plumbing + 50k + the riders (M).** Items 1–10, 13–16: the four buckets, the `ultra-50k` template, non-race events, and distance-derived plausibility. No renderer changes. Both 2026-06-05 transcripts would have produced real plans with U1 landed.
- **U2 — long ultras (L).** Items 11–12 + the back-to-back cap field. The renderer work is the bulk.
- **Later — periodic volume goals (§6).** Unscheduled; analyzed so it doesn't get redesigned from scratch when it's pulled.

Sequencing stays open (decision #2, §8): onboarding v3 W4–W6 is in flight and the plan-renderer race-date bug is a named must-fix; neither queues behind this.

---

## 6. Future: periodic volume goals (analyzed, deferred)

The third goal shape from real users: "20 miles a week," "80 miles a month," occasionally hours — a self-set volume target with no race. Analyzed 2026-06-05 (decision #8, §8) and deliberately deferred. The finding worth recording: **it fits the existing architecture as a parameter, not a redesign.**

- **Intake:** a `general_fitness` athlete — keep_fit routing already exists. One optional slot (`volume_goal: {amount, unit, period}`), normalized to weekly miles in code. Period ambiguity ("100 — per week or month?") is the same numeric-slot class the §5.1 machinery handles, chips and all. Months normalize to weeks at extraction (the whole system thinks in weeks); echo both back: "80 a month — call it 18–19 a week."
- **Plan-gen:** no new template. `base-maintenance` already ramps from the Strava snapshot toward a peak; the only change is the peak being the stated target instead of the template cap, plus a ramp-to-target-then-hold behavior on the open_ended overlay. Safety comes free — the ramp caps govern, and "I run 10 a week, goal is 40" is the contradiction-surface case.
- **Daily coaching:** the actual product value — "you're at 14 of your 20 with two days left" — is `strava_recent.json` plus a goal sentence in a memory file. The V3-W7 non-race coach branch is the natural home: it needs a progress narrative to replace race-countdown framing, and a weekly target is a better spine than generic consistency.
- **Until it ships:** the pocket (V3-W8) keeps these athletes from breaking the intake — the goal is acknowledged, stored in their words, and the athlete rides keep_fit with the coach aware of the target.
- **The trap, named:** no grand unified goal abstraction (race goals + volume goals + streaks). Nothing about volume goals demands one; building it would be scope without need.

Hours-based targets defer with this feature (convertible from observed pace when wanted; U2's time-on-feet work adds `planned_duration_min` on runs anyway, so the shapes converge rather than conflict).

---

## 7. Out of scope

Named so they don't creep in: vert-targeting from course profiles (the race's `elevation_gain_ft` informs description copy, nothing more), crew/pacer/drop-bag logistics, night-run periodization, multi-day and timed events (Backyard Ultra formats have no fixed distance and don't fit the bucket model — they land in the pocket, honestly), qualifier/lottery tracking, and renaming `marathon_training_plan.json`.

---

## 8. Decisions

Resolved 2026-06-05 (first pass):

1. **Bucket granularity:** granular — `50k` / `50mi` / `100k` / `100mi`. Per-distance plausibility, caps, and selection stay data-driven; exact distance stays in `races.distance_mi`.
2. **Phasing:** spec everything, build nothing yet. U1/U2 split recorded above; scheduling decided separately against the v3 backlog.
3. **Tier handling:** no hard gate. Ultra × any tier selects a template; beginner/for_fun targeting 50mi+ surfaces through the safety-contradiction confirm.

Resolved 2026-06-05 (second pass, after the Chase transcript and triage):

4. **Intake-side failure handling moves to v3.** The uncatalogued-goal pocket and the derivation mechanism are V3-W8 (`ONBOARDING_V3.md` §5.2–§5.3); the confirm-loop and stale-date bugs are `Specs/V3_HARDENING_PROMPT.md`. This doc owns catalog and plan-gen expansion only.
5. **Buckets are internal training archetypes.** The athlete-visible distance is always `races.distance_mi`; a 44-miler selects the `50mi` structure with no "rounding" messaging — there is nothing to round.
6. **Non-race events ride U1** (athlete-stated fill, fuzzy dates, `event_kind` — §3.5).
7. **Plausibility goes distance-derived** (pace-envelope window from `distance_mi`), with the bucket table kept only as the fallback for bucket-only goals (§3.2).
8. **Periodic volume goals: deferred, shape recorded** (§6). No goal-model redesign now; the pocket covers these athletes in the interim.

Open (for sign-off when a build is scheduled):

9. Cap, volume, and pace-envelope numbers in §3.2–§3.4 are DRAFT and need David's review, same as the W3 caps did.
10. `time_goal` suppression on both ultra templates — confirm, or allow a reference-pace variant for experienced 50k athletes.
11. Whether U1 lands before or after v3 W4–W6 cutover.
