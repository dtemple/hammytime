# Readiness v2 — Strava-aware event readiness

**Status: Phase 0 BUILT (SPEC / CHANGELOG v0.7.50, 2026-06-25), divergence folded
in.** Builds on v1 (the event-conditioning guardrail, v0.7.48):
`computeReadiness`/`renderReadiness` in `src/lib/plan-drift.ts`, the `# Race
readiness` headline in `plan_drift.md`, and the coach's "Protect the goal-race
buildup" floor. The §11 open questions are resolved (see "Decisions" below);
weekly-volume adherence and any push remain deferred (§9 Phase 1+).

## Decisions (resolved with David 2026-06-25)

1. **Data source** — separate paginated fetch + a once-per-athlete-per-day cache
   (`strava_realized_cache`); `strava_recent.json`'s 14-day fetch untouched.
   NOT a widened raw dump, NOT an append-only log, NOT Strava's MCP (§3).
2. **Realized rung** — biggest actual long run over a trailing ~5-week window
   (`REALIZED_RUNG_WINDOW_WEEKS = 5`), not biggest-ever — a long-ago peak since
   detrained must not flatter reachability.
3. **"Done" tolerance** — hybrid: `actual ≥ 0.85 × planned` OR `actual ≥ planned − 2 mi`
   (`LR_DONE_PCT = 0.85`, `LR_DONE_ABS_MI = 2`).
4. **Divergence** — built now (folded into Phase 0), inform-only with an
   ask-don't-assert coach framing; no auto plan-edit / confirm button.
   `DIVERGENCE_SLACK_WEEKS = 1`.

Built surface: `fetchActivitiesSince` + `bucketRealizedSeries` +
`buildRealizedSeries` (cache) + the `computeReadiness` realized logic + the
render reconcile/caveat lines + the `goalBuildupGuidance` reconcile sentence +
the `strava_realized_cache` migration. Thresholds above are DRAFT — they join
v1's in the single calibration pass once real Strava + edit history exists.

---

## 1. The problem v1 leaves open

v1 readiness is **plan-vs-plan**. `computeReadiness` reads the working plan's
long-run spine against the baseline plan's spine. It answers "given the edits the
coach has *written into the plan*, can the buildup still reach the start line
ready?" — which is exactly David's stated fear (accommodations the coach keeps
making), and v1 handles that path well.

The blind spot is **the plan and reality diverging without an edit.** If the
athlete silently skips or shortens long runs — never asks the coach to move them,
so the plan is never edited — the schedule still shows those long runs as planned,
the spine looks intact, and v1 reports ON TRACK while the athlete is, in fact,
falling behind. The verdict trusts the calendar; the calendar can lie.

Today the backstops for that path are indirect: the daily run reconciles banked/
missed sessions against `strava_recent.json` (coach.md), and the Sunday review's
"week behind" beat reads the 7-day Strava picture. Both are the coach noticing in
prose, run by run. Neither feeds the **verdict**. v2 closes that: it grounds the
readiness verdict in what the athlete actually ran.

---

## 2. What v2 adds

The readiness verdict ingests the athlete's **realized** long-run history (from
Strava), not just the scheduled one. Three concrete gains:

1. **Realized rung.** The "current rung to climb from" becomes the biggest long
   run *actually completed*, not the biggest one *planned and reached on the
   calendar*. Reachability is then grounded in real fitness.
2. **Divergence flag.** When the plan shows long runs the athlete didn't actually
   do (planned, week passed, no matching run in Strava), surface it — the plan and
   reality have drifted apart and the coach should reconcile (edit the plan, or
   address why the athlete is behind).
3. **Adherence as a verdict input.** Count missed/short long runs from *actuals*,
   so the silent-skip path can pull a verdict to WATCH/AT RISK even when no edit
   was ever made.

Secondary (cheap, same data): **weekly-volume adherence** — actual weekly miles vs
planned, for past weeks — as a supporting axis alongside the long-run spine.

---

## 3. Data source — the key architectural decision

Readiness needs the **per-week longest run across the whole build** (12–18+
weeks). The existing `strava_recent.json` is a ~14-day window, capped for token
reasons — too short for the realized spine. So v2 needs a new, longer-horizon but
**compact** source.

**Recommended: a server-side weekly rollup.** In `worker/strava.ts`
(`buildStravaContext` already owns the Strava fetch), add a rollup that fetches
*run* activities since the plan's `start_date`, buckets them into the plan's weeks
by date, and reduces each week to two numbers: **max single-run distance**
(realized long run) and **summed run distance** (realized weekly volume). The
output is a small array — one `{ week_number, actualLongRunMi, actualVolumeMi }`
per elapsed week — not raw activities, so the token cost on the read path stays
flat regardless of history length. Pass it into `computeReadiness` from
`folder.ts` (which already has the plan and the Strava client).

**Rejected alternatives:**

- *Widen the raw `strava_recent.json` dump to the full build.* Blows the read-path
  token budget (the whole reason the 14-day cap and the current-block view exist).
  We need a derived rollup, not more raw data in the folder.
- *Incrementally append a `long_run_log.md` each run.* More moving parts and an
  eventual-consistency hole: a backfilled/late-synced activity, or any run before
  the log existed, is missed. A fresh rollup over the window each hydrate is
  simpler and self-healing.
- *Use an MCP — the Kailo `context_*` tools, or Strava's official MCP connector
  (launched 2026, `support.strava.com/.../15401531`).* Doesn't fit. Strava's MCP
  is explicitly **consumer-facing, "not for application backends"**: per-user
  **interactive OAuth** inside an AI client (Claude.ai/Cowork/Claude Code — no
  human in a headless cron worker to click "Connect"), and **subscriber-only**
  (we require only the free `activity:read_all` scope, not Strava premium for
  every friend). It's also redundant — we already hold each athlete's OAuth token
  and call the REST API server-side — and it would reopen the §4 scope lock (no
  MCP catalog in the worker; Bash denied; Strava pre-fetched so the agent never
  makes live calls). The rollup lives in the same pre-fetch path as everything
  else; the deterministic per-week reduction belongs in code, not an LLM-driven
  MCP query.

**Cost/rate-limit note.** The rollup is extra Strava API calls per hydrate
(paginated over the build window). At friends scale (5–25 athletes, one daily run
each) that's well within Strava's per-app limits, but it should share the HTTP
budget with the existing fetch and be **cached/computed at most once per athlete
per day** (the realized series only changes when a new activity lands). Spell the
caching out before building at any larger scale.

---

## 4. The realized-spine model

`computeReadiness` gains an optional realized series. With it present:

- **Realized rung** = max `actualLongRunMi` across elapsed weeks (replaces v1's
  planned `currentRungMi`). Falls back to the planned rung when the series is
  absent (Strava broken/disconnected) — i.e. v2 degrades to v1.
- **Reachability** = `realizedRung + buildWeeksLeft × maxLongRunStepMi ≥
  baselinePeak − tolerance`. Same formula, grounded in reality.
- **Adherence / divergence.** For each *past* planned long run, compare the week's
  `actualLongRunMi` to the planned long run. A planned long run with no actual
  within tolerance (and no shorter substitute) is a **missed long run**; count
  them. If `missedLongRuns ≥ 1` while the plan still *shows* those weeks as done
  (no edit), set `planDiverged = true`.
- **Weekly-volume adherence** (secondary): actual vs planned cumulative running for
  elapsed weeks, as a supporting signal next to v1's planned-cumulative drift.

The matching is **date-bucketed, week-max** — robust to a long run done a day or
two off its planned slot (it still lands in the same week). A long run shifted
across a week boundary is rarer; week-max handles the week it actually landed in,
and the divergence flag tolerates one week of slack before firing.

---

## 5. Verdict changes

The three verdicts stay (ON TRACK / WATCH / AT RISK); the inputs sharpen:

- **AT RISK** now also fires when the realized rung — not just the scheduled
  spine — can't reach the peak in the runway. A silently-skipped long-run block
  reaches AT RISK even with an unedited (rosy-looking) plan.
- **WATCH** gains a trigger: `planDiverged` (plan shows long runs reality doesn't)
  → WATCH with a "reconcile the plan with what you've actually run" reason, even
  when the scheduled spine looks intact.
- **ON TRACK** requires the realized spine to track, not just the planned one.

The render gains a line when `planDiverged`: e.g. "Plan shows the 18 mi (week 5)
as done; Strava has no run over 11 mi that week — reconcile before trusting the
calendar." The coach then either edits the plan to match reality or raises the
gap with the athlete.

---

## 6. Plumbing (files touched)

- `worker/strava.ts` — the weekly rollup (run-only, since plan start, bucketed to
  plan weeks → `{ week_number, actualLongRunMi, actualVolumeMi }[]`), with the
  once-per-day cache.
- `worker/folder.ts` — compute the realized series and pass it into
  `computeReadiness` (alongside the plan + `today` it already passes).
- `src/lib/plan-drift.ts` — `computeReadiness` gains the optional realized series;
  realized rung, adherence/divergence, volume-adherence; render the divergence
  line. Pure and total as today; absent series → v1 behavior.
- `worker/prompts/coach.md` — a sentence on the divergence line and reconciling
  plan-vs-reality (the verdict already feeds the existing buildup + Sunday flow).
- Tests: realized-rung reachability, the silent-skip → AT RISK case, the
  divergence flag, and Strava-broken → v1 fallback.

---

## 7. Edge cases

- **Strava broken / disconnected.** No realized series → fall back to v1
  (plan-only), and the readiness header says so plainly ("based on the plan;
  Strava data is stale, so this may overstate readiness"). Never silently present
  a plan-only verdict as if it were reality-grounded.
- **Untracked long runs** (treadmill, watch dead, not synced). The athlete did the
  work; Strava can't see it → a false divergence/miss. Mitigation: the divergence
  line is framed as "reconcile," not "you skipped it," and the coach can clear it
  in conversation. Document the limit; don't pretend Strava is complete.
- **Cross-training** (a long hike, a big ride). Not a running long run — excluded
  from the rung, but worth a note for the coach (it's load, not specificity).
- **Race-pace vs easy long runs.** v2 counts distance only; quality of the long
  run is out of scope (a v3 concern).
- **Plan start undatable.** No usable plan dates → no rollup window → v1 fallback.

---

## 8. DRAFT thresholds (to calibrate with the v1 ones)

- **Long-run "done" tolerance** — how close an actual must be to the planned long
  run to count as done (e.g. within 2 mi, or ≥ ~85% of planned). DRAFT.
- **Divergence slack** — weeks of grace before `planDiverged` fires (default 1, to
  absorb a long run shifted across a week boundary).
- **Volume-adherence watch** — actual cumulative running below planned by >X% →
  contributes to WATCH (reuse v1's 10% as a starting point).

These join v1's thresholds (peak tol 1 mi, lost cut ≥3 mi, taper 2 wk, step from
the cap) in the single calibration pass once real coach-edit + Strava history
exists.

---

## 9. Phasing

- **Phase 0 — BUILT (v0.7.50).** The rollup + realized rung + the silent-skip →
  AT RISK path + Strava-broken fallback, **plus the divergence flag** and the
  coach's reconcile line (folded forward from the draft's Phase 1: it shares the
  same per-week bucketed data the rung needs, so splitting it was artificial).
- **Phase 1 (remaining):** weekly-volume adherence as a verdict axis (the rollup
  already computes `actualVolumeMi`; it doesn't feed the verdict yet) + the
  calibration pass against real data.

---

## 10. Out of scope (still)

- Pushing alerts to **athlete or admin** — readiness stays coach-context only (the
  coach decides what to say). A push/escalation is a separate, later decision.
- Biometric / HRV / sleep signals into readiness.
- Crediting cross-training toward the long-run spine.
- Long-run *quality* (pace/effort), not just distance.

---

## 11. Open questions for David — RESOLVED (2026-06-25)

See "Decisions" at the top. In short:

1. **Strava call budget / caching** → once-per-athlete-per-day cache
   (`strava_realized_cache`), recomputed on day-roll or plan-version change.
2. **"Done" tolerance** → hybrid (85% of planned OR within 2 mi).
3. **Untracked long runs** → accept the false-divergence risk with the reconcile /
   ask-don't-assert framing; no off-Strava affordance (deferred).
4. **Divergence action** → inform the coach only; no auto plan-reconciliation edit.
5. **Realized rung** → biggest in a trailing ~5-week window (not biggest-ever).
