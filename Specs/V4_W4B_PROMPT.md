# V4-W4b — `event_kind` + non-race adventure fill (next implementation step)

_Paste this into a fresh session. It is self-contained; it assumes no memory of the
session that built V4-W4 (the catalog slice)._

## What you're building

**V4-W4b: the non-race adventure path** — the W1-deferred half of the v4 catalog work,
held back from W4 because it needs a `races.event_kind` migration and a commit-branch
change. Today a goal that isn't a looked-up race has nowhere to land: `lookupRace`
returns `not_found` and the engine dead-ends ("I couldn't pin that race down…"). After
this, a **personal objective with a date** — a friend's route, a self-set adventure run —
is a first-class event: filled from the athlete's own words, stored with
`event_kind='adventure'`, and built into a real plan.

Three concrete outcomes:

- A **sub-40-mile adventure** (e.g. David's mid-July ~20-miler, or a 33-mile route) gets a
  **real structured plan** — `event_kind='adventure'`, the bucket derived from the stated
  distance (≤40mi → a real bucket → real plan), the athlete's own name/date on the race row.
- A **fuzzy date** ("September", "mid-July") resolves to a **mid-month placeholder**, not a
  rejection — the same mechanics the `intended` branch already uses; the plan builds toward
  the placeholder and the coach firms it up later.
- The **recap** and (optionally, deferred) race-week copy read `event_kind`, so an adventure
  reads as "your run", not "your race."

**This prompt is scoped web + ONE migration (`races.event_kind`), push to Vercel, NO
`fly deploy`.** The optional worker-side "your run vs your race" coach copy touches
`worker/` (a `fly deploy`) and `ULTRA_SUPPORT.md` calls it cosmetic — **defer it** (see
"After W4b").

## Read first (source of truth)

1. **`Specs/CHANGELOG.md` v0.7.46** — the authoritative record of what W4 (the catalog
   slice) built. **Read this first**: it documents the two David decisions that changed the
   design out from under the older spec body (see "The W4 reconciliation" below).
2. **`Specs/ULTRA_SUPPORT.md`** — the **U1 status note at the top** (post-v4-reconciliation),
   **§3.5** (non-race events: athlete-stated fill, fuzzy dates, `event_kind`), **§3.7**
   (copy changes). Note the top status note supersedes §3.1/§3.4's "consented proxy for
   50mi+" with the off-ramp.
3. **`Specs/ONBOARDING_V4.md`** — **§9** (eval fixtures — but read the "Superseded for
   beyond-50k" callout at the top of §9), **§10 V4-W4 line** (what's built, what W4b owns).
4. **`CLAUDE.md`** — §2 (source-of-truth order), §9 (working agreement — scoped unit,
   confirm before expanding), §10 (git/deploy — `git status` first; the engine sees
   concurrent sessions; commit + push when green).

## The W4 reconciliation — the #1 load-bearing thing

W4b's design in `ULTRA_SUPPORT.md` §3.5 and `ONBOARDING_V4.md` §9 predates a David decision
made while building W4. **That decision changes W4b. Honor the new shape:**

- **Beyond the 50k OFF-RAMPS — it does not proxy.** The old spec said a 44-mile adventure
  (Chase's Rae Lakes Loop) gets a *consented proxy plan*. **It does not.** W4 made anything
  past the 50k (>40mi) take a **gentle off-ramp**: acknowledge, state the 50k ceiling, ask
  for a shorter event or tune-up to build around — no proxy, no `keep_fit`, no future-plan
  promise; the goal rides as an intent. The off-ramp is **already built**
  (`engine/pocket.ts` `ultraOffRampBody` + `applyUltraOffRamp`, routed from
  `applyStatedDistance` and `resolveRace`).
- **So the adventure fill is CEILING-BOUNDED.** When the athlete's adventure carries a
  distance >40mi, the fill must **not** create a 44-mile adventure race row — it must route
  to the **existing off-ramp** (reuse `applyUltraOffRamp` / the off-ramp message). The
  adventure fill only fills for **≤40mi** objectives (which derive to a real bucket:
  17–28→`marathon`, 28–40→`50k`). A `50k`-band adventure → `ultra-50k` plan; a marathon-band
  adventure → marathon plan. **If you find yourself filling a 44-mile adventure race row +
  proxy, stop — that's the retired design.**
- **Lean enum.** Only `50k` is a real bucket; `50mi/100k/100mi` are not in the enum. Don't
  reintroduce them.

## What's already built — REUSE, don't reinvent

- **The off-ramp** (`engine/pocket.ts`): `ultraOffRampBody(distanceMi)` and
  `applyUltraOffRamp(state, words)` (clears the goal slots, demotes the words to an intent).
  Routed today from `applyStatedDistance` (a stated >40mi distance) and `resolveRace` (a
  looked-up race >40mi). **A beyond-50k adventure must reach this**, not a new pocket.
- **Bucket derivation** (`engine/numeric.ts` `deriveBucketFromMiles`): tops out at the `50k`
  band (28–40mi → `50k`; >40 → `null` → off-ramp). An adventure's stated distance runs
  through this to pick the bucket.
- **The commit goal-write** (`engine/commit.ts` `buildGoalWrite` ~64): the **committed**
  branch (`raceName && raceDate`) already writes a `races` row with `name`/`date`/
  `distance_mi`/`target_type`/`target_time_sec`. An adventure is a committed-shaped goal
  with `event_kind='adventure'` and the athlete's real `distance_mi` (not the bucket
  nominal). The **intended** branch already carries a non-ISO placeholder date.
- **`resolveRace` not_found** (`engine/router.ts` ~637): today returns the dead-end
  "I couldn't pin that race down…" — this is the hook the adventure fill replaces (fill from
  the athlete's words instead of dead-ending).
- **The recap** (`engine/guardrails.ts` `buildRecapMessage` ~387 + `recapDisplayedSlots`):
  builds the goal line; gains an `event_kind` read for the "your run" framing.
- **`races` table** (`supabase/migrations/20260518000000_initial_schema.sql` ~51): columns
  `name, date, distance_mi, elevation_ft, terrain, target_type, target_time_sec, status` —
  **no `event_kind` yet** (this slice adds it). Distance has always been freeform numeric, so
  an adventure's real distance fits with no other change.

## The `event_kind` migration (the new artifact)

A new numbered migration, modeled on the recent ALTER-style ones (e.g.
`20260625000000_athlete_check_back_at.sql`):

```sql
alter table races
  add column event_kind text not null default 'race'
  check (event_kind in ('race', 'adventure'));
```

`race` default keeps every existing row valid. **Apply to prod** (Supabase) — separate from
the Vercel push. Regenerate / hand-edit `db-types.ts` for the new column (the project
hand-edits it; see prior sessions).

## The adventure fill (the core behavior)

- **A signal that the goal is an adventure.** Carry `event_kind` on the v3 state (or a flag
  on the goal slots), default `race`, set to `adventure` when the fill fires. `buildGoalWrite`
  reads it and writes `race.event_kind`. (Decide the exact carrier with David — a top-level
  `state.event_kind` mirrors how `out_of_catalog` rides; keep it simple.)
- **The fill, at `resolveRace` not_found** (and/or when the athlete plainly describes a
  personal objective the model surfaces as non-race): instead of the dead-end, fill
  `goal_race` (the name from their words), `goal_date` (their date — fuzzy → placeholder),
  `distance_mi` (their stated distance), provenance `stated`, **one inline confirm, no
  lookup**. Then the existing committed branch in `buildGoalWrite` writes the row with
  `event_kind='adventure'` and the real `distance_mi`.
- **Ceiling-bounded (the reconciliation):** before filling, run the stated distance through
  `deriveBucketFromMiles`. ≤40mi → a real bucket → fill + real plan. >40mi → **off-ramp**
  (reuse `applyUltraOffRamp` + `ultraOffRampBody`), never an adventure proxy. No distance
  stated yet → the normal distance-required gate asks for it, then derive.
- **`buildGoalWrite`:** the adventure write reuses the committed branch but sets
  `distance_mi` to the athlete's real number (already the `realDistanceMi` shape) and adds
  `event_kind`. The `goal_state` is `committed` (a dated objective) or `intended` (date
  pending) as today.

## Fuzzy dates

"September" / "mid-July" → ask once if useful ("got a specific day, or just sometime in
September?"); a month-only answer takes a **mid-month placeholder** — the same mechanics the
`intended` branch already uses (a non-ISO string that `isPastISODate` treats as never-past;
`numeric.ts`). The plan builds toward the placeholder; the coach firms it up when the athlete
does. **Reuse the intended-branch placeholder mechanics — don't invent a new date type.**

## The recap `event_kind` line

`buildRecapMessage` (`guardrails.ts` ~387): an adventure recaps as "your run"/"adventure",
not "race" — e.g. `• Goal: Rae Lakes Loop, 33 mi (adventure)` vs the race framing. Update
`recapDisplayedSlots` if the displayed-slot set changes. Generated copy — Daybreak voice, no
AI tells (`CLAUDE.md` §3 hard rules).

## Settle with David before building

- **The `event_kind` carrier on the state** (a top-level `state.event_kind` vs a slot flag) —
  recommend the simplest (top-level, mirrors `out_of_catalog`).
- **Fuzzy-date copy** — the one-line "specific day, or just sometime in September?" wording.
- **Confirm the off-ramp boundary holds for adventures** — a >40mi adventure off-ramps (no
  proxy), matching the W4 decision. (This should not be a surprise; flag it so it's explicit.)
- **The recap framing string** for an adventure (athlete-facing copy).

## Constraints / gotchas

- **Web + ONE migration — push (Vercel) + apply `races.event_kind` to prod; NO `fly deploy`.**
  If you reach for a `worker/` change, that's the deferred cosmetic copy — stop and confirm.
- **Honor the off-ramp (the #1 risk, above):** a beyond-50k adventure off-ramps; do NOT
  build a consented proxy for it. Don't reintroduce `50mi/100k/100mi` buckets.
- **Don't reopen anti-goals** (`CLAUDE.md` §5).
- **Collision discipline** (`CLAUDE.md` §10): `git status` first; the onboarding engine sees
  concurrent sessions. Stage only your files; if foreign changes appear, stop and flag.
- **Generated copy** (`CLAUDE.md` §3 hard rules): the fill confirm, the recap line, and any
  fuzzy-date ask are athlete-facing — David's voice, humanizer guidelines.

## Definition of done

- A **sub-40 adventure** (named route or self-set goal, no `lookupRace` hit) is filled from
  the athlete's words with one confirm, stored `event_kind='adventure'` with the real
  `distance_mi`, and renders a **real plan** (marathon-band ≤28mi, `ultra-50k` 28–40mi).
- A **fuzzy date** resolves to a mid-month placeholder, not a rejection; the plan builds
  toward it.
- A **beyond-50k adventure** (a 44-miler) **off-ramps** (reuses the W4 off-ramp) — NOT a
  proxy, NOT an adventure race row.
- The **recap** reads `event_kind` (an adventure reads as "your run"/"adventure").
- `event_kind` is on the `races` row (migration applied), written by `buildGoalWrite`, and
  in `db-types.ts`.
- Tests: an adventure fill → real plan + `event_kind='adventure'` + real distance; a fuzzy
  date → placeholder; a 44-mile adventure → off-ramp (proof it's not a proxy); the recap
  adventure line. `npm run typecheck`, `lint`, `test`, `build` all green.
- Commit + push (web); apply the migration to prod. Update `Specs/CHANGELOG.md` (next
  version), `Specs/ONBOARDING_V4.md` §10 (W4b → built; the §9 adventure fixtures land),
  `Specs/ULTRA_SUPPORT.md` (§3.5 landed), `claude-status.md` per §8.

## After W4b

- **Optional cosmetic (deferred):** worker race-week copy reading `event_kind` ("your run"
  vs "your race") in `worker/prompts/coach.md` — touches `worker/` (a `fly deploy`);
  `ULTRA_SUPPORT.md` calls it cosmetic. Defer unless David wants it.
- **Remaining v4:** **W5** (web positioning copy — David wordsmiths), **W6 / V3-W5** (the eval
  harness — the launch gate before opening to more users). **U2** (50mi+ renderer work:
  `ultra-endurance`, back-to-back long runs, time-on-feet) stays deferred.
