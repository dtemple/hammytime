# V4-W4 — Ultra catalog (U1) + distance-derived plausibility (next implementation step)

_Paste this into a fresh session. It is self-contained; it assumes no memory of the
sessions that built V4-W2/W3._

## What you're building

**V4-W4: adopt the `ULTRA_SUPPORT.md` U1 catalog** so the product covers dated efforts
**up to ~40 miles** with a real structured plan, and recognizes longer ones honestly
instead of wedging them into the marathon enum. Two concrete outcomes:

- A **50k** athlete gets a real plan (a new `ultra-50k` template — a long trail marathon
  that reuses existing renderer machinery, no renderer changes).
- A **44-miler / 100k / 100-miler** is recognized as a real distance and gets an **honest
  proxy with consent** via the *existing* uncatalogued-goal pocket — never silently a
  marathon, never wedged into a bad enum value. The proxy ceiling rises from `marathon`
  to `ultra-50k`.
- Finish-time **plausibility becomes distance-derived** (a pace envelope over the stated
  miles) so a 44-mile or 100k time resolves instead of pocketing on a missing table row.

**This prompt is scoped to the catalog + plausibility slice — web-only, push to Vercel,
NO migration, NO `fly deploy`.** The `event_kind` column, the non-race **adventure fill**
(athlete-stated goal + fuzzy dates), and the recap `event_kind` line are the W1-deferred
half — they need a `races.event_kind` migration and a commit-branch change, so they are
**W4b, the next step after this one.** Don't build them here (see "After W4").

## Read first (source of truth)

1. **`Specs/ULTRA_SUPPORT.md`** — **§3.1** (the four buckets + the distance→bucket table),
   **§3.2** (distance-derived plausibility — the pace envelope + the bucket-only fallback
   table), **§3.3** (long-run safety caps per bucket — DRAFT), **§3.4** (the `ultra-50k`
   template spec), **§3.6 + §7** (what U2 defers — read this so you don't build it).
2. **`Specs/ONBOARDING_V4.md`** — **§6** (catalog scope: adopt U1, defer U2; the "coverage
   up to ~40 miles" line and the 50mi+ "consented proxy" rule), **§9** (the four eval
   fixtures — the 50k race, the sub-40 adventure, the 44-mile fuzzy adventure, the WS100
   ultra race), **§10 V4-W4 line**, **§11** (the DRAFT numbers + `time_goal` decisions David
   still owns).
3. **`CLAUDE.md`** — §2 (source-of-truth order), §9 (working agreement — scoped unit,
   confirm before expanding; this workstream is big, hold the line), §10 (git/deploy —
   `git status` first; sessions collide on the engine + `worker/`).

## The U1/U2 boundary — the #1 load-bearing risk

**U1 ships exactly ONE new template: `ultra-50k`.** The buckets `50mi / 100k / 100mi` are
internal archetypes for *plausibility and (later) the proxy mapping* — they do **NOT** get
their own template in U1. The `ultra-endurance` template (and back-to-back long runs,
time-on-feet long runs) is **U2 — deferred** (`ULTRA_SUPPORT.md` §3.6, §7).

So: **do not add `ultra-endurance` to `TemplateId`, and do not point `50mi/100k/100mi` at a
template in the selector.** A 50mi+ goal must route through the **pocket** to a consented
`ultra-50k` (or marathon) proxy — the same machinery V3-W8 already built. Wiring 50mi+ to a
real template would reopen the U2 scope lock and ship an unsafe plan (no b2b long runs, no
time-on-feet). If you catch yourself creating `ultra-endurance.ts`, stop.

**Decide with David (scoping):** does W4 add `50mi/100k/100mi` to the `GoalDistanceValue`
enum now (as recognized-but-pocketed buckets, for the §3.2 fallback table), or add **only
`50k`** as a real bucket and keep 50mi+ as pure out-of-catalog distances handled by the
miles-based pace envelope + pocket? The leaner path (only `50k` in the enum) avoids enum
values with no template that the selector could trip on; the §3.2 ultra fallback rows are a
bucket-only convenience that mostly matters once U2's templates exist. **Recommend the lean
path** unless David wants the full four buckets in the enum now.

## What's already built — REUSE, don't reinvent

- **Distance-derived plausibility may already exist.** `engine/numeric.ts` already has
  `PACE_ENVELOPE_SEC_PER_MI` (`{ min: 230, max: 1500 }` ≈ 3:50–25:00/mi) and
  `resolveFinishTimeForMiles(seconds, miles)` (numeric.ts ~52). **Read numeric.ts first** —
  much of §3.2 may be wiring `resolveFinishTime` to call the miles path when a concrete
  distance exists, plus widening `deriveBucketFromMiles` (numeric.ts ~101, today caps at
  `marathon`/28mi) and raising the `target_time` numeric max (schema.ts ~261, today 8h) for
  ultra finish times. Don't rebuild the envelope.
- **The pocket / proxy-with-consent is fully built (V3-W8).** `OutOfCatalogGoal` on the v3
  state (`slots/slot-state.ts` ~83), `engine/pocket.ts` (`proxyFor` ~33, `pocketBody` ~66,
  the consent state machine), and the commit read of `out_of_catalog.consent === 'accepted'`
  (`engine/commit.ts` ~214) all exist. W4 **raises the proxy ceiling** (`proxyFor` returns
  `ultra-50k` instead of `marathon` for the long side once `ultra-50k` exists) and updates
  the `pocketBody` copy ("I top out around the 50k" rather than "the marathon"). It does not
  build a new pocket.
- **The template system is a clean registry.** `src/lib/plan-templates/`: `types.ts`
  (`GoalDistance`, `TemplateId`), `selector.ts` (`SELECTION_TABLE` distance×tier→template,
  `DISTANCE_MILES`), `index.ts` (`TEMPLATES` registry), `caps.ts` (`maxLongRunMiByDistance`),
  and one file per template under `templates/`. `ultra-50k.ts` is a new file modeled on
  `marathon-performance.ts`. `selectPlan` maps via `SELECTION_TABLE`.
- **The enum lives in two places that must stay in sync** — `GoalDistanceValue`
  (`slots/schema.ts` ~32, the onboarding slot) and `GoalDistance` (`plan-templates/types.ts`
  ~25, the template catalog). Plus the validators that enumerate distances: `guardrails.ts`
  `DISTANCE` set (~34) + `DISTANCE_LABELS` (~346), and the model's `ENUM_RULES`
  (`extract-and-advance.ts` ~236). Miss one and a stated `50k` either fails validation or
  the model paraphrases it.

## The `ultra-50k` template (the core new artifact)

Per `ULTRA_SUPPORT.md` §3.4 — a marathon-performance skeleton with: `distances: ['50k']`,
**effort-led pace model** (no Riegel/`time_goal` pace derivation — trail paces don't map),
**long-run cap ~26mi**, peak volume cap **~60mi** (DRAFT — David signs off), trail overlay
effectively default (most 50ks are trail; existing `deriveTerrain` handles it),
`nutrition_practice` flagged on long runs from mid-build, and **`time_goal` overlay
suppressed** — a stated target is recorded as race-strategy reference, not a pace driver.
Register it in `index.ts` + `SELECTION_TABLE` (`50k → ultra-50k` for all four tiers) +
`DISTANCE_MILES` (`50k: 31.1`) + `caps.ts` (`50k: 26`).

## Settle with David before building

- **Scoping:** the full four buckets in the enum vs. `50k`-only + miles-based for the rest
  (above). **Recommend `50k`-only.**
- **The DRAFT numbers** (`ULTRA_SUPPORT.md` §8 decision #9): pace envelope floor ~3:50 /
  ceiling ~25:00 per mile, `ultra-50k` long-run cap 26 + peak ~60, and (if you add them) the
  §3.2 ultra fallback finish-time rows. These are DRAFT — confirm before they harden into a
  template.
- **`time_goal` suppression on `ultra-50k`** (§8 decision #10): suppress entirely, or allow a
  reference-pace variant for an experienced 50k athlete? Spec leans suppress.
- **The new proxy ceiling:** a 44-miler now proxies to `ultra-50k` (31mi), not `marathon` —
  confirm that's the intended honest-proxy target, and reword `pocketBody` to match.

## Constraints / gotchas

- **Web-only — push (Vercel), NO `fly deploy`, NO migration.** The catalog, templates,
  selector, plan-gen, plausibility, and pocket copy all run gen-time on Vercel. If you find
  yourself adding a migration or editing `worker/`, that's W4b/U2 — stop and confirm.
- **Don't build U2** (the #1 risk, above): no `ultra-endurance` template, no 50mi+ template
  mapping, no back-to-back long runs, no time-on-feet.
- **Don't reopen anti-goals** (`CLAUDE.md` §5).
- **Collision discipline** (`CLAUDE.md` §10): `git status` first; the onboarding engine and
  `worker/` see concurrent sessions. Commit + push promptly when green. Stage only your
  files; if foreign changes appear, stop and flag.
- **Generated copy** (`CLAUDE.md` §3 hard rules): the pocket message and any new labels are
  athlete-facing — no AI tells, David's voice, humanizer guidelines.

## Definition of done

- A **50k** goal selects `ultra-50k` and renders a real plan: effort-led paces, long-run cap
  honored, no time-goal pace driver, trail default.
- A **44-mile / 100k / 100mi** goal is recognized (real distance kept in the athlete's words)
  and the **plan is the consented `ultra-50k` (or marathon) proxy** via the pocket — not a
  silent marathon, not a wedged enum value (the V3-W8 / U1 fix).
- **Finish-time plausibility is distance-derived** — a stated 44-mile or 100k time resolves
  via the pace envelope instead of pocketing on a missing range.
- The enum is in sync across `schema.ts`, `plan-templates/types.ts`, `guardrails.ts`
  (set + labels), and `ENUM_RULES`; a stated `50k` validates and isn't paraphrased.
- Tests: the §9 fixtures that this slice covers — **50k race → real `ultra-50k` plan**,
  **44-mile → consented proxy plan** (proof it's not silently a marathon), plus
  distance-derived plausibility unit cases and the `deriveBucketFromMiles` widening. The
  safety-contradiction surfacing (15mi/wk + 3 days + ITB + 44 mountain miles) should still
  fire before plan-gen.
- `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` all green.
- Commit + push (web-only). Update `Specs/CHANGELOG.md` (next version),
  `Specs/ONBOARDING_V4.md` §10 (W4 catalog slice → built; note W4b remains) and
  `Specs/ULTRA_SUPPORT.md` (mark U1 catalog landed, DRAFT numbers David-confirmed),
  `claude-status.md` per §8.

## After W4 (this slice)

- **W4b — `event_kind` + non-race adventure fill (the W1-deferred half).** A migration
  adding `races.event_kind` (`race | adventure`, default `race`); the commit **adventure-fill
  branch** in `buildGoalWrite` (`engine/commit.ts` ~64) — when `lookupRace` returns
  `not_found` for a personal objective, fill `goal_race`/`goal_date`/`distance_mi` from the
  athlete's own words with `event_kind='adventure'`, one inline confirm, no lookup; **fuzzy
  dates** ("September" → mid-month placeholder, the intended-branch mechanics); and the
  **recap `event_kind` line** (`guardrails.ts` `buildRecapMessage` ~387 + `recapDisplayedSlots`).
  Eval fixtures: the sub-40 adventure (real plan) and the Chase 44-mile fuzzy adventure
  (consented proxy). Optional light worker touch: the coach's race-week copy reading
  `event_kind` ("your run" vs "your race") — `ULTRA_SUPPORT.md` calls this cosmetic and
  defer-able.
- **Remaining v4:** W5 (web positioning copy — David wordsmiths), W6 (eval harness — the
  launch gate). **U2** (50mi+ renderer work: `ultra-endurance`, back-to-back long runs,
  time-on-feet) stays deferred (§6, §3.6).
