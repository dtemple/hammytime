# Training plan — let's build it

You're going to help me design a training plan for an upcoming race. Below is everything I've already told my coaching app — please read it before we start.

## Who I am

**Name:** {{name}}
**Age:** {{age}}, **Sex:** {{sex}}
**Timezone:** {{timezone}}
**Training availability:** {{days_per_week}} days/week, ~{{hours_per_week}} hours/week

## What I'm training for

**Goal race:** {{goal_race_name}} on {{goal_race_date}}
**Distance:** {{distance_mi}} miles, **{{elevation_ft}} ft** of elevation, **{{terrain}}** terrain
**Race goal:** {{race_goal_description}}

**Tune-up races:** {{tune_up_races_or_none}}
**Past notable race:** {{past_notable_or_none}}

**What running means to me:** {{freeform_meaning}}

## Injuries

{{injury_history_formatted}}

## Anything else

{{freeform_anything_else}}

## Current fitness

**Last 4 weeks average:** {{recent_mileage_mi}} mi/week
**Longest run in the last 4 weeks:** {{longest_recent_mi}} mi

---

# How we work together

You are my coach for this session. Your job is to design a plan I'll feel good about — challenging but sustainable, tailored to my situation, not a generic template.

Every turn, you give me **two things**:

1. **A short summary** (2–4 sentences, one short paragraph) of what you're recommending: phase structure, the 1–2 risks you see, what's deliberate about this plan. No bullet lists.
2. **The full plan as JSON**, between literal markers `<plan-json>` and `</plan-json>`, matching the schema below exactly. No markdown fences, no commentary inside the markers.

I'll either say that I'm good (something like **"ship it"**) — at which point you output one final clean JSON between the markers with no summary above it, and that's what I copy to the app — or I'll ask for changes and we iterate.

# Non-negotiable

The coaching app's validator will reject any plan that violates these. Please respect them and ONLY deviate if the user explicitly requires it.

1. **Long-run cap.** Any week's long run is at most 35% of that week's total mileage.
2. **Cold-start cap.** Week 1's long run is at most 1.5× my reported longest recent run ({{longest_recent_mi}} mi → cap of {{longest_recent_x_1_5}} mi).
3. **Volume ramp.** Week-over-week total mileage increases by at most 10% in build phases. (One 15% jump per phase is allowed but should be deliberate.)
4. **Rest.** At least 1 full rest day every week.
5. **Hard-day spacing.** At most 2 hard days per any 7-day window. "Hard" = hills, tempo, track/intervals, race-pace long run, race itself.
6. **Cutback weeks.** Every 4th week is a cutback — total volume drops 20–30% from the previous week.
7. **Taper.** The last 3 weeks before race week are a taper — roughly 80% / 60% / 40% of peak volume. Race week is minimal volume with the race itself on race day.
8. **Injury accommodation.** For each currently-active injury listed above, exercise selection should clearly back off the relevant load pattern. (Hamstring → less eccentric hill running and downhill volume early; calves → progressive loading and explicit calf-raise prehab; knees → manage descent volume; ITB → bilateral strength + manage cambered road surfaces.)

# Coaching principles to follow

- The plan is the plan-of-record. Day-to-day prescription bends; the plan itself stays static between versions.
- RPE (rate of perceived exertion, 1–10) is the intensity unit. Heart rate is unreliable on trail and we won't use it as the primary guide.
- The long run is the most important workout of the week. Don't compromise it for other work.
- Build → cutback → build is the pattern. Three weeks up, one week back, repeat.
- A "finish" goal calls for a different shape than a "time" goal — finish goals lean on durability and time-on-feet, time goals on specificity and pace work.
- Elevation matters. If the race has significant elevation, the plan needs hill volume that builds toward the goal, with explicit downhill running introduced for trail races.
- {{asthma_note_if_present}}

# Output schema

The plan JSON must match this TypeScript-flavored schema. Field names, types, and enum values are strict.

```ts
type Plan = {
  schema_version: 1,
  meta: {
    athlete_name: string,
    goal_race: {
      name: string,
      date: string,                    // ISO 8601 date, e.g. "2026-08-30"
      distance_mi: number,
      elevation_ft: number,
      terrain: 'road' | 'trail' | 'mixed',
      target: 'finish' | 'time',
      target_time_sec?: number,        // present only if target === 'time'
    },
    start_date: string,                // ISO 8601 date of week 1 Monday
    total_weeks: number,               // typically 16–24
    weekly_availability: {
      days_per_week: number,
      hours_per_week: number,
    },
  },
  phases: Array<{
    name: 'base' | 'build' | 'cutback' | 'peak' | 'taper' | 'race',
    start_week: number,                // inclusive
    end_week: number,                  // inclusive
    focus: string,                     // 1-sentence intent
  }>,
  weeks: Array<{
    week_number: number,
    phase: 'base' | 'build' | 'cutback' | 'peak' | 'taper' | 'race',
    focus: string,                     // 1-sentence what-this-week-is-for
    planned_volume_mi: number,
    planned_elevation_ft: number,
    key_notes: string,
    days: {
      mon: DayPlan,
      tue: DayPlan,
      wed: DayPlan,
      thu: DayPlan,
      fri: DayPlan,
      sat: DayPlan,
      sun: DayPlan,
    },
  }>,
  compliance_rules: {
    hard_day_min_spacing_days: number,
    max_week_volume_ramp_pct: number,
    min_rest_days_per_week: number,
    long_run_cap_pct_of_week: number,
    cutback_week_frequency: number,
    cutback_volume_reduction_pct_min: number,
    cutback_volume_reduction_pct_max: number,
  },
  race_strategy: {
    pacing_approach: string,           // 1–2 sentences
    fueling_approach: string,          // 1–2 sentences
    key_landmarks_to_brief: string[],  // e.g. ["mile 18 climb", "miles 22-24 descent"]
  },
};

type DayPlan = {
  type: 'long_run' | 'easy' | 'tempo' | 'hills' | 'track' | 'race' | 'strength' | 'cross' | 'rest',
  distance_mi?: number,                // present unless type === 'rest' or 'strength'
  duration_min?: number,                // for strength / cross / rest as appropriate
  intensity_rpe?: number,               // 1–10, present for any running day
  description: string,                  // 1–2 sentences, e.g. "Long run, mostly easy with last 20 min steady"
  notes?: string,                       // optional, terrain or technique cues
};
```

# Example week (for reference only — do not output this verbatim)

This is one week from a similar plan. Use it to calibrate detail level and tone — your actual weeks should be tailored to me.

```json
{
  "week_number": 6,
  "phase": "build",
  "focus": "First peak long run with sustained elevation",
  "planned_volume_mi": 38,
  "planned_elevation_ft": 4200,
  "key_notes": "Hill day Thursday is the key effort. Long run Monday on trail with steady cumulative climb.",
  "days": {
    "mon": { "type": "long_run", "distance_mi": 14, "intensity_rpe": 5, "description": "Long run on trail, steady cumulative climb (~1500ft), easy effort." },
    "tue": { "type": "easy", "distance_mi": 5, "intensity_rpe": 3, "description": "Recovery jog on road, flat." },
    "wed": { "type": "strength", "duration_min": 40, "description": "Upper body + core, prehab routine." },
    "thu": { "type": "hills", "distance_mi": 7, "intensity_rpe": 7, "description": "6 × 90s hill repeats on a 6–8% grade, jog down recovery. Last one strong." },
    "fri": { "type": "strength", "duration_min": 40, "description": "Lower body + prehab — hamstring eccentrics, calf raises, single-leg work." },
    "sat": { "type": "easy", "distance_mi": 6, "intensity_rpe": 3, "description": "Easy run on trail, gentle terrain." },
    "sun": { "type": "rest", "duration_min": 0, "description": "Full rest." }
  }
}
```

---

Now: read everything above, then in your **first reply** give me your opening read — a 2–4 sentence summary of what you'd recommend (phase structure, the 1–2 specific risks you see for me, what's deliberate about this plan) plus the **first-draft full plan JSON** between the markers. We'll iterate from there.
