# Prehab principles — load map, day-type roles, dose rules

Read-only reference for the coaching agent. This is the knowledge behind the two-layer prehab
model: how training load maps to tissue demand (for picking the contextual layer), what each kind
of day's message does prehab-wise, and the dose rules the standing routine follows. The athlete's
actual program lives in `prehab_program.md` — this file is how you select and time the work.

## Rules for the agent

- **Selection knowledge, not a movement library.** Movements named here may or may not have an
  `exercises.md` entry. The library rules apply unchanged: when an exercise is in the library, use
  its cues and link; when it isn't, prescribe it plainly with no link — never invent one.
- **A causal tie must be real and observable.** Connect a contextual prescription to a named
  recent activity, an `injury_log.md` entry, an upcoming race demand, or a soreness/wellness
  trend. If nothing in recent training matches a row in the load map, prescribe no contextual
  prehab — that is the correct output, not a miss.
- **Suggestions, not rehab.** Anything that reads like a real injury — pain that changes gait,
  sharp or localized pain, swelling, pain that isn't improving — goes to a physio or doctor, per
  the exercise-library rules.

## Source + vetting

Conservative, mainstream sports science only: heavy-slow resistance and eccentric loading for
tendon adaptation (Achilles, patellar), eccentric hamstring strength for strain-risk reduction,
and standard run-training load management. Anything contested is cut from this file, not hedged.

Content last verified by David: PENDING SIGN-OFF (drafted 2026-06-09).

## 1. Load → tissue map

Read `strava_recent.json` (and the race calendar) through this table to pick the contextual layer.

| Signal in recent training                                        | Tissue demand                                                                            | Prehab implication                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Big climb volume (high ft/mi, uphill running or hiking)          | Soleus/gastroc, Achilles, glutes & hip extensors                                         | Post: calf care. Anticipatory: soleus + gastroc capacity work                                                                                                                                                                          |
| Sustained descents                                               | Eccentric quad load, patellar tendon, braking calves                                     | Post: easy mobility only — don't stack eccentric loading on DOMS. Anticipatory (≥4 weeks out): eccentric quad work (lateral step-downs, Spanish squats) builds descent tolerance; closer than that it adds soreness without adaptation |
| Speed work, strides, racing                                      | Hamstrings (high-velocity strain risk), hip flexors, calf/Achilles (forefoot loading)    | Keep heavy hamstring eccentrics (Nordics, sliders) ≥48h clear of quality days                                                                                                                                                          |
| Long runs                                                        | Late-run form breakdown loads hip stabilizers (glute med) and core; plantar/foot fatigue | Glute-med work on non-adjacent days; day after = easy mobility                                                                                                                                                                         |
| Sudden weekly-volume ramp                                        | Tendons adapt slower than fitness: Achilles, plantar fascia, bone load                   | Bias the routine toward tendon care; name the ramp in the message                                                                                                                                                                      |
| Long hikes / time on feet                                        | Hip flexor stiffness, calves                                                             | Hip flexor mobility, calf care                                                                                                                                                                                                         |
| Technical/cambered trail                                         | Ankle stabilizers, peroneals                                                             | Balance work, short-foot                                                                                                                                                                                                               |
| Upcoming race terrain (from `race_calendar.md` + course profile) | Whatever the course demands                                                              | Anticipatory work needs lead time; nothing new in race week                                                                                                                                                                            |

## 2. Day-type prehab roles

What each kind of day's message does, prehab-wise:

- **Rest day** — the routine's natural home; heavier loading work belongs here.
- **Strength day** — fold routine items into the session; never double-prescribe the same
  movement as both "strength" and "prehab" in one day.
- **Day before quality or a race** — light activation at most; no new heavy eccentric work within
  ~48h of quality.
- **Post-long-run / post-race day** — mobility and easy movement; no heavy loading.
- **Easy run day** — contextual layer only, or nothing.
- **Race week** — maintenance of familiar work at reduced volume; nothing new.

## 3. Dose and selection rules

- Standing routine: 2–3 scheduled sessions/week, ~10–15 min. Consistency over months beats
  variety for tendon adaptation — do not rotate routine contents for novelty.
- Contextual layer: 0–2 items, each with a stated causal tie. No signal → no contextual prehab,
  and that's correct, not a miss.
- Repetition with awareness: when the same signal persists, the same prescription is right —
  acknowledge the continuing thread rather than re-presenting it cold.
- Movements come from `exercises.md` when available (cues + link per existing rules);
  off-library prescriptions follow the existing no-invented-links rule.
