# Prehab v2 — standing program + load-aware contextual layer

**Status: built + deployed 2026-06-09 (CHANGELOG v0.7.29). David vetted the §4 science
(P1 sign-off) the same day; the worker is live on Fly.** This doc is the design record and
implementation plan; the v0.7.27 entry recorded the design, v0.7.29 the build. Remaining: the §6
observation week against David's own transcript.

---

## 1. Problem

Read `transcripts/dtemple_gmail.com.md`: the coach prescribes the same three-exercise block —
hamstring bridge holds 3×45s/leg, eccentric calf raises 3×15, hip flexor stretch 2×60s/side — in
nearly every message, every day, regardless of message type. David's report: it reads stale, he's
started ignoring it, and it carries no insight. What he wants instead: prehab that connects to
what he actually did ("Tuesday's hills loaded your calves, so today do X") or what's coming
("Dipsea's descents will hammer your quads — start this now"), at a frequency he'll actually follow.

### Root cause

The repetition is the deterministic output of the current prompt, not model laziness:

1. **Hard-coded priorities.** `worker/prompts/coach.md` §Prehab says "Always prescribe prehab given
   the injury history... Prioritize the proximal-hamstring, knee-stability, and calf/Achilles work
   this athlete needs," and the Never list ends with "Skip prehab." A fresh stateless agent reads the
   same injury history and the same instruction every run and converges on the same three exercises.
2. **Multi-tenant bug.** That priorities line is literal text in the shared template — those are
   *David's* injury priorities, sent to every athlete regardless of `{{injury_history}}`. Same
   problem one layer up: `worker/system-prompt.ts` `missionLine()` bakes "including prehab — every
   time you write to them" into both coach modes.
3. **No memory of what was prescribed.** The agent writes "prehab given" into `checkin_log.md` after
   each run but is never told to read it back. The ingredient for continuity exists on disk, unconsumed.
4. **No activity→tissue knowledge.** `exercises.md` is organized by body region, but nothing maps
   training load to tissue demand. The agent occasionally improvises the connection ("those Dipsea
   descents tax the calves on a delay") — but the *selection* never varies, so even good rationale
   reads as justification for the same list.
5. **Prehab in every message type.** Daily check-ins, ad-hoc replies, plan reworks — all end with the
   same three bullets. Half the wallpaper effect is frequency, not content.

### Design stance

The staleness is a **messaging failure, not a programming failure**. The evidence-based protocols the
routine is made of (heavy-slow tendon loading, eccentric hamstring work) depend on doing the *same*
exercises 2–3×/week for months — a coach who rotates them daily for novelty is a worse coach. So the
fix is not to randomize the prescription. It is to split prehab into two layers with different change
rates:

- **The standing program** — boring on purpose, consistent for months, surfaced only on its 2–3
  scheduled days per week. Communicated once with rationale, then referenced, never re-listed daily.
- **The contextual layer** — the insight. Zero to two items, only ever with a causal tie to something
  observable: a named recent activity, an `injury_log.md` entry, an upcoming race demand, a wellness
  trend. "Nothing today" is a valid prescription.

This is the "D-lite" decision (2026-06-09): the day-type structure lives in prompt + files the agent
owns, not in the plan JSON. See §7 for what's deliberately deferred.

---

## 2. Decisions (David, 2026-06-09)

1. **Agent-authored program**, not template-seeded. The coach writes `prehab_program.md` from the
   athlete's injury history + profile + early Strava signal on the first daily run where the file is
   absent. In keeping with the architecture; no per-injury-profile template library.
2. **Repetition is allowed when the load signal legitimately persists** (hills three days running →
   the calf focus is still right). The requirement is *awareness*: the coach must know what it
   prescribed recently and acknowledge the thread ("same calf focus as yesterday — the hills are
   still the story"), never repeat amnesiacally. Variety comes from real load variation, not a
   rotation schedule.
3. **Routine frequency: 2–3 days/week, scheduled.** Matches the dosing of the underlying protocols
   (heavy-slow resistance ~3×/week; strength maintenance 2×/week). Daily prescription is both
   clinically unnecessary and compliance-poisonous — when it's every day, it gets ignored every day.
   On non-routine days the routine does not appear at all.
4. **The load map gets its own knowledge file**, separate from `exercises.md`. Different kind of
   claim (causal sports-science mappings vs movement instructions), own vetting header and changelog.
5. **D-heavy (prehab in plan JSON → calendar) is deferred**, contingent on a few weeks of observed
   behavior. Every D-lite artifact carries forward unchanged if it's ever built; the only deferred
   thing is a rendering surface. See §7.

---

## 3. New memory file: `prehab_program.md` (per-athlete, agent-authored)

A normal `memory_files` row, created by the coach itself. **No migration, no seeding** —
`worker/folder.ts` `syncBack()` already upserts files the agent creates. Absent file = not yet
authored (same convention as `known_gaps.md`).

### Authoring (first daily run where the file is missing — or earlier on a direct ask)

> Amendment (David, 2026-06-09, at build time): an explicit athlete prehab question in an ad-hoc
> message may also trigger authoring — the announcement lands as the answer to their question,
> rather than answering loose and "formalizing" a possibly-different routine the next morning.
> The daily run remains the default trigger.

- Derive from: `{{injury_history}}` (system prompt), `athlete_profile.md`, `injury_log.md`, the
  `strength_equipment` known-gap state, and recent Strava signal.
- For an athlete with existing coaching history (everyone at deploy time): read the prehab column of
  recent `checkin_log.md` entries and **consolidate what's already been prescribed** — present the
  program as formalizing the routine they know, not a new program.
- Announce it once in that day's message: the routine, the why (tied to *their* injury history), and
  which days it lands on. After that, reference it; re-list the exercises only on routine days.

### Contents (skeleton)

```markdown
# Prehab program — <name>

## Standing routine
2–4 movements with dose, each tied to a reason from this athlete's injury history.
- <exercise> — <sets×reps/hold> — why: <one line>

## Schedule
Anchored to day-types, with the current weekday mapping derived from the plan.
- Anchor: rest day + strength days (default; coach's judgment per plan shape)
- This week: <weekdays>

## Revision log
- YYYY-MM-DD — authored. <one line>
```

### Revision rules

Revised on triggers, never daily: a new/changed `injury_log.md` entry; a plan block transition
(entering taper or race week); an athlete request; a load-map signal that persists across weeks.
Each revision appends a dated one-liner to the revision log. When the athlete reshuffles the week
(long run moves), the **day-type anchors hold** and only the weekday mapping line updates — a cheap
edit the coach makes alongside the plan edit, no confirm flow (it's a memory file, not the plan; the
coach states the new routine days in its message and the athlete can object in chat).

---

## 4. New knowledge file: `worker/knowledge/prehab-principles.md` (read-only corpus)

Same hydration path as `exercises.md`: copied into the athlete folder at hydrate, added to
`INPUT_ONLY_FILES`, ships in the worker image. Same vetting discipline: a "last verified" header,
David signs off on the content before deploy. This is the first installment of the long-deferred
`principles.md` (house coaching defaults), scoped to prehab only.

Three sections. Draft content below is **for David's vetting at build time** — conservative,
mainstream sports-science only; anything contested gets cut rather than hedged.

### 4.1 Load → tissue map

What the coach reads `strava_recent.json` through to pick the contextual layer.

| Signal in recent training | Tissue demand | Prehab implication |
|---|---|---|
| Big climb volume (high ft/mi, uphill running or hiking) | Soleus/gastroc, Achilles, glutes & hip extensors | Post: calf care. Anticipatory: soleus + gastroc capacity work |
| Sustained descents | Eccentric quad load, patellar tendon, braking calves | Post: easy mobility only — don't stack eccentric loading on DOMS. Anticipatory (≥4 weeks out): eccentric quad work (lateral step-downs, Spanish squats) builds descent tolerance; closer than that it adds soreness without adaptation |
| Speed work, strides, racing | Hamstrings (high-velocity strain risk), hip flexors, calf/Achilles (forefoot loading) | Keep heavy hamstring eccentrics (Nordics, sliders) ≥48h clear of quality days |
| Long runs | Late-run form breakdown loads hip stabilizers (glute med) and core; plantar/foot fatigue | Glute-med work on non-adjacent days; day after = easy mobility |
| Sudden weekly-volume ramp | Tendons adapt slower than fitness: Achilles, plantar fascia, bone load | Bias the routine toward tendon care; name the ramp in the message |
| Long hikes / time on feet | Hip flexor stiffness, calves | Hip flexor mobility, calf care |
| Technical/cambered trail | Ankle stabilizers, peroneals | Balance work, short-foot |
| Upcoming race terrain (from `race_calendar.md` + course profile) | Whatever the course demands | Anticipatory work needs lead time; nothing new in race week |

### 4.2 Day-type prehab roles

What each kind of day's message does, prehab-wise:

- **Rest day** — the routine's natural home; heavier loading work belongs here.
- **Strength day** — fold routine items into the session; never double-prescribe the same movement
  as both "strength" and "prehab" in one day.
- **Day before quality or a race** — light activation at most; no new heavy eccentric work within
  ~48h of quality.
- **Post-long-run / post-race day** — mobility and easy movement; no heavy loading.
- **Easy run day** — contextual layer only, or nothing.
- **Race week** — maintenance of familiar work at reduced volume; nothing new.

### 4.3 Dose and selection rules

- Standing routine: 2–3 scheduled sessions/week, ~10–15 min. Consistency over months beats variety
  for tendon adaptation — do not rotate routine contents for novelty.
- Contextual layer: 0–2 items, each with a stated causal tie. No signal → no contextual prehab, and
  that's correct, not a miss.
- Repetition with awareness: when the same signal persists, the same prescription is right —
  acknowledge the continuing thread rather than re-presenting it cold.
- Movements come from `exercises.md` when available (cues + link per existing rules); off-library
  prescriptions follow the existing no-invented-links rule.

---

## 5. Prompt + code changes

### 5.1 `worker/prompts/coach.md`

- **Files list**: add `prehab_program.md` (athlete data, coach-authored and -maintained) and
  `prehab-principles.md` (read-only reference, like `exercises.md`).
- **§Prehab — full rewrite.** Delete the hard-coded priorities line (the multi-tenant bug). New
  content: the two-layer model; authoring instructions for a missing `prehab_program.md` (§3 above);
  routine surfaces only on its scheduled days; contextual layer requires a causal tie to something
  observable; nothing is a valid prescription; before prescribing, scan the prehab column of the
  last ~7 days of `checkin_log.md` and acknowledge any thread being continued.
- **Daily run section, item 4** becomes: prehab per today's day-type role — routine on routine days,
  contextual insight or nothing on the others.
- **Ad-hoc replies**: prehab only when the message content makes it relevant.
- **Post-activity notes**: may carry one time-sensitive contextual item when the just-finished
  activity creates one (the "before your legs stiffen" pattern — the transcript's best existing
  prehab moments are these); otherwise none.
- **Never list**: replace "Skip prehab" with two lines — never skip the standing routine on its
  scheduled day, and never re-list the full routine on a day it isn't scheduled.
- **After-you-write**: `checkin_log.md` entry keeps recording prehab given, now including "none".

### 5.2 `worker/system-prompt.ts`

`missionLine()`: drop "— including prehab — every time you write to them" from both coach modes;
prehab cadence is now owned by coach.md + the program file, not the mission sentence.

### 5.3 `worker/folder.ts`

Copy `prehab-principles.md` at hydrate alongside `exercises.md`; add it to `INPUT_ONLY_FILES`.
`prehab_program.md` is deliberately **not** input-only — it's athlete data and must sync back.

### 5.4 Tests

- `worker/__tests__` folder tests: the new corpus file hydrates and is excluded from sync-back;
  `prehab_program.md` written by the agent *is* synced back.
- system-prompt tests: mission line no longer mentions prehab; template still renders (no new
  placeholders).

No DB migration, no web change, no new env vars. **Worker-only deploy**: commit → push → `fly deploy`.

---

## 6. Rollout + verification

1. **P1 — content.** Author `prehab-principles.md` (§4 draft → David vets the science, cuts anything
   contested). Nothing deploys until sign-off.
2. **P2 — build.** §5 changes + tests. Standard gates: `npm run test`, `typecheck`, `lint`,
   `npm run build`.
3. **P3 — deploy + observe.** `fly deploy`, then watch David's own transcript for ~a week. Existing
   athletes need no backfill — each one's first daily run after deploy authors their program file and
   introduces the routine as a consolidation of what they've been given.

What "working" looks like in the transcript (these become eval fixtures when `EVAL_HARNESS.md`
V3-W5 lands):

- The routine appears on its 2–3 scheduled days and on **no** other day.
- Contextual prehab always names its cause ("Saturday's 2,300 ft of climbing", "Dipsea's descents,
  June 14"), and some days carry none.
- A persisting signal repeats *with acknowledgment*, not verbatim re-presentation.
- A plan reshuffle moves the routine days' weekday mapping without dropping the anchors.
- A second athlete's program reflects *their* injury history, not David's (the multi-tenant fix).

Cost: one added knowledge file (~1.5–2k tokens) per run hydration; `checkin_log.md` is already in
the folder. Negligible against current run cost.

---

## 7. Deliberately out of scope

- **D-heavy: prehab in `marathon_training_plan.json` → the subscribed calendar.** Deferred until the
  D-lite structure has a few weeks of observed behavior. Rationale recorded here so it isn't
  relitigated: the plan file has ask-first/drift-tracked change discipline that's wrong for a
  fast-adapting layer; the schema ripple (plan-schema.ts, templates, validators, plan-repair,
  calendar feed) is a multi-session build; and nothing in D-lite is throwaway — D-heavy would only
  add a rendering surface on top of the same program file. The partial substitute meanwhile: routine-
  day messages lead with the routine instead of appending it.
- **Dynamic warmup drills** — still its own deferred category (see `exercises.md` header).
- **New `exercises.md` entries.** If the load map wants a movement that's missing, prescribe it
  link-less per existing rules and flag the gap to David; don't grow the corpus in this build.
- **Prehab compliance tracking** (did the athlete actually do it) — nothing new; the coach may ask,
  as it already does.
