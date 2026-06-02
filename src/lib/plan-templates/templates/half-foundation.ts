// Template — half-foundation (onboarding v2, W3).
//
// First half-marathon / finish goal. Selected for half × {beginner, for_fun}.
// Conservative and effort-led: one light quality day, long run capped ~15,
// bodyweight strength. `time_goal` is suppressed at this tier (no pace work off
// an invented target).

import type { PlanTemplate } from '../types';

export const halfFoundation: PlanTemplate = {
  id: 'half-foundation',
  label: 'Half marathon — foundation',
  distances: ['half'],
  band: 'foundation',
  appliesToTiers: ['beginner', 'for_fun'],

  phases: [
    {
      name: 'base',
      weight: 0.3,
      minWeeks: 3,
      maxWeeks: 6,
      openEndedKeep: true,
      description: 'Aerobic foundation; build the long-run habit at an easy effort.',
    },
    {
      name: 'build',
      weight: 0.45,
      minWeeks: 4,
      openEndedKeep: true,
      description: 'Progressive volume; long run grows steadily toward the cap.',
    },
    {
      name: 'peak',
      weight: 0.15,
      minWeeks: 1,
      maxWeeks: 3,
      openEndedKeep: false,
      description: 'Longest runs; settle into race-day endurance.',
    },
    {
      name: 'taper',
      weight: 0.1,
      minWeeks: 1,
      maxWeeks: 2,
      openEndedKeep: false,
      description: 'Cut volume, arrive fresh.',
    },
    {
      name: 'race',
      weight: 0,
      minWeeks: 1,
      maxWeeks: 1,
      openEndedKeep: false,
      description: 'Race week — minimal running, maximum rest.',
    },
  ],

  cutback: { everyNWeeks: 4, volumePct: 0.8 },

  volume: {
    startVolumeFloorMi: 12,
    peakVolumeCapMi: 30,
    peakMultiplierMax: 1.8,
    longRun: {
      startAnchor: 'strava_longest',
      capMi: 15,
      weeklyStepMi: 2,
      postCutbackStepMi: 3,
      shareOfWeeklyMax: 0.4,
    },
  },

  microcycles: {
    3: ['long_run', 'easy', 'quality'],
    4: ['long_run', 'easy', 'easy_with_strides', 'quality'],
    5: ['long_run', 'easy', 'easy', 'easy_with_strides', 'quality'],
  },

  workoutMenu: [
    {
      id: 'strides',
      dayType: 'easy_with_strides',
      phases: ['base', 'build'],
      strides: { count: [4, 6], durationSec: 20, recovery: 'full jog back' },
      description: 'Easy run + short relaxed strides.',
    },
    {
      id: 'gentle-tempo',
      dayType: 'tempo',
      phases: ['build', 'peak', 'taper'],
      tempoBlockMin: [10, 18],
      description: 'Comfortably-hard tempo block off an easy warm-up.',
    },
  ],

  paceModel: { primary: 'effort', deriveFromTarget: false, derivation: 'none' },

  strength: {
    defaultSessionsByTier: { beginner: 1, for_fun: 1, some_training: 2, experienced: 2 },
    placement: 'combine_with_easy_day',
    defaultEquipment: 'bodyweight_only',
    sessions: {
      lower_body: {
        standard_duration_min: 25,
        taper_duration_min: 15,
        race_week_duration_min: 10,
        exercises: [
          {
            name: 'Single-leg calf raises',
            exercise_slug: 'single-leg-calf-raise',
            sets: 3,
            reps: 12,
            reps_unit: 'per_side',
          },
          {
            name: 'Split squats',
            exercise_slug: 'bulgarian-split-squat',
            sets: 3,
            reps: 10,
            reps_unit: 'per_leg',
          },
          { name: 'Glute bridges', sets: 3, reps: 15 },
          {
            name: 'Side planks',
            exercise_slug: 'side-plank',
            sets: 2,
            reps: 30,
            reps_unit: 'seconds',
          },
        ],
      },
      upper_body: {
        standard_duration_min: 25,
        taper_duration_min: 15,
        race_week_duration_min: 10,
        exercises: [
          { name: 'Push-ups', sets: 3, reps: 10 },
          {
            name: 'Dead bugs',
            exercise_slug: 'dead-bug',
            sets: 3,
            reps: 10,
            reps_unit: 'per_side',
          },
          { name: 'Plank', exercise_slug: 'front-plank', sets: 3, reps: 40, reps_unit: 'seconds' },
        ],
      },
    },
  },

  guidanceBase: {
    description: 'Effort-led foundation half-marathon guidance.',
    pace_zones: {
      note: 'Finish goal — lead with heart rate and perceived effort, not pace.',
      easy: {
        description: 'Conversational; full sentences.',
        hr_zone: [1, 2],
        hr_percent_max: [60, 75],
        rpe: [3, 5],
      },
      long_run: {
        description: 'Slightly slower than easy; time on feet.',
        hr_zone: [1, 2],
        hr_percent_max: [60, 72],
        rpe: [3, 5],
      },
      tempo: {
        description: 'Comfortably hard; short phrases only.',
        hr_zone: [3, 4],
        hr_percent_max: [76, 87],
        rpe: [6, 7],
      },
      strides: {
        description: 'Short relaxed bursts; full recovery.',
        hr_zone: [4, 5],
        hr_percent_max: [85, 95],
        rpe: [7, 8],
      },
    },
    compliance_rules: [
      {
        rule_id: 'easy_pace_too_fast',
        description: 'Easy and long runs should stay in zone 1–2.',
        condition: 'avg_hr_percent_max > 75 on easy or long_run',
        action: 'Advise slowing down — easy-run pace creep is the #1 amateur mistake.',
      },
    ],
    modification_triggers: {
      feeling_great:
        'Add 0.5–1 mi to easy runs if effort stays in zone 1–2, but do NOT extend the long run beyond plan.',
      feeling_fatigued:
        'Cut easy distances ~20%, keep the long run but slow it, consider an extra rest day in place of strength.',
      time_crunched: 'Priority: long run > quality day > strength > second easy run.',
      weather_disruption: 'Treadmill is fine; keep efforts easy.',
    },
  },

  supportsOverlays: ['trail', 'injury', 'open_ended'],
};
