// Template — half-development (onboarding v2, W3).
//
// Half-marathon with training history. Selected for half × {some_training,
// experienced}. Pace-capable: goal race pace derived from the target time when
// one is set, one-to-two quality days (threshold + intervals), long run capped
// ~15. `time_goal` overlay is open.

import type { PlanTemplate } from '../types';

export const halfDevelopment: PlanTemplate = {
  id: 'half-development',
  label: 'Half marathon — development',
  distances: ['half'],
  band: 'development',
  appliesToTiers: ['some_training', 'experienced'],

  phases: [
    {
      name: 'base',
      weight: 0.25,
      minWeeks: 2,
      maxWeeks: 5,
      openEndedKeep: true,
      description: 'Aerobic base; reintroduce strides and light tempo.',
    },
    {
      name: 'build',
      weight: 0.45,
      minWeeks: 4,
      openEndedKeep: true,
      description: 'Threshold and interval work; long run grows; goal pace introduced.',
    },
    {
      name: 'peak',
      weight: 0.2,
      minWeeks: 2,
      maxWeeks: 4,
      openEndedKeep: false,
      description: 'Race-specific work at goal pace; highest volume.',
    },
    {
      name: 'taper',
      weight: 0.1,
      minWeeks: 1,
      maxWeeks: 2,
      openEndedKeep: false,
      description: 'Cut volume, hold intensity, sharpen.',
    },
    {
      name: 'race',
      weight: 0,
      minWeeks: 1,
      maxWeeks: 1,
      openEndedKeep: false,
      description: 'Race week — primed and rested.',
    },
  ],

  cutback: { everyNWeeks: 4, volumePct: 0.8 },

  volume: {
    startVolumeFloorMi: 18,
    peakVolumeCapMi: 40,
    peakMultiplierMax: 1.7,
    longRun: {
      startAnchor: 'strava_longest',
      capMi: 15,
      weeklyStepMi: 2,
      postCutbackStepMi: 3,
      shareOfWeeklyMax: 0.4,
    },
  },

  microcycles: {
    4: ['long_run', 'easy', 'quality', 'quality'],
    5: ['long_run', 'easy', 'quality', 'easy', 'quality'],
    6: ['long_run', 'easy', 'quality', 'easy', 'easy_with_strides', 'quality'],
  },

  workoutMenu: [
    {
      id: 'threshold-tempo',
      dayType: 'tempo',
      phases: ['build', 'peak', 'taper'],
      warmupMin: 10,
      cooldownMin: 10,
      tempoBlockMin: [15, 30],
      description: 'Threshold block — comfortably hard, controlled.',
    },
    {
      id: 'vo2-intervals',
      dayType: 'intervals',
      phases: ['build', 'peak'],
      warmupMin: 12,
      cooldownMin: 10,
      repeats: [4, 6],
      repeatDistanceM: 800,
      recovery: '2 min easy jog',
      description: 'VO2 intervals — 800m reps at 5k effort.',
    },
    {
      id: 'strides',
      dayType: 'easy_with_strides',
      phases: ['base', 'build'],
      strides: { count: [4, 8], durationSec: 20, recovery: 'full jog back' },
      description: 'Easy run + relaxed strides.',
    },
  ],

  paceModel: { primary: 'pace', deriveFromTarget: true, derivation: 'riegel' },

  strength: {
    defaultSessionsByTier: { beginner: 1, for_fun: 1, some_training: 2, experienced: 2 },
    placement: 'combine_with_easy_day',
    defaultEquipment: 'bodyweight_only',
    sessions: {
      lower_body: {
        standard_duration_min: 30,
        taper_duration_min: 20,
        race_week_duration_min: 12,
        exercises: [
          {
            name: 'Single-leg calf raises',
            exercise_slug: 'single-leg-calf-raise',
            sets: 3,
            reps: 15,
            reps_unit: 'per_side',
          },
          {
            name: 'Split squats',
            exercise_slug: 'bulgarian-split-squat',
            sets: 3,
            reps: 12,
            reps_unit: 'per_leg',
          },
          {
            name: 'Single-leg glute bridges',
            exercise_slug: 'single-leg-glute-bridge',
            sets: 3,
            reps: 12,
            reps_unit: 'per_side',
          },
          {
            name: 'Side planks',
            exercise_slug: 'side-plank',
            sets: 3,
            reps: 40,
            reps_unit: 'seconds',
          },
        ],
      },
      upper_body: {
        standard_duration_min: 25,
        taper_duration_min: 15,
        race_week_duration_min: 12,
        exercises: [
          { name: 'Push-ups', sets: 3, reps: 15 },
          {
            name: 'Dead bugs',
            exercise_slug: 'dead-bug',
            sets: 3,
            reps: 12,
            reps_unit: 'per_side',
          },
          { name: 'Plank', exercise_slug: 'front-plank', sets: 3, reps: 50, reps_unit: 'seconds' },
        ],
      },
    },
  },

  guidanceBase: {
    description: 'Pace-capable development half-marathon guidance.',
    pace_zones: {
      note: 'Lead easy on effort; tempo, intervals, and goal-pace work lead on pace when a time is set.',
      easy: {
        description: 'Conversational; full sentences.',
        hr_zone: [1, 2],
        hr_percent_max: [60, 75],
        rpe: [3, 5],
      },
      long_run: {
        description: 'Easy to steady; goal-pace finishes layered in late in the build.',
        hr_zone: [1, 3],
        hr_percent_max: [60, 82],
        rpe: [3, 6],
      },
      tempo: {
        description: 'Threshold — comfortably hard, short phrases only.',
        hr_zone: [3, 4],
        hr_percent_max: [82, 90],
        rpe: [6, 8],
      },
      interval: {
        description: 'VO2 reps — hard, near top sustainable effort.',
        hr_zone: [4, 5],
        hr_percent_max: [88, 95],
        rpe: [8, 9],
      },
      marathon_pace: {
        description: 'Goal race pace — steady and repeatable on the edge of comfortable.',
        hr_zone: [3, 4],
        hr_percent_max: [82, 89],
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
        description: 'Easy and recovery runs should stay in zone 1–2.',
        condition: 'avg_hr_percent_max > 78 on easy or recovery runs',
        action: 'Slow the easy days down — easy has to be easy for the quality to land.',
      },
    ],
    modification_triggers: {
      feeling_great:
        'Hold the build; add a stride or two rather than extra volume. Bank freshness for the taper.',
      feeling_fatigued:
        'Drop one quality day to easy this week; keep the long run but cut any goal-pace segment.',
      time_crunched: 'Priority: quality day > long run > second quality > strength > easy run.',
      weather_disruption:
        'Move threshold/interval work indoors; keep the long run outside if you can.',
    },
  },

  supportsOverlays: ['trail', 'injury', 'open_ended', 'time_goal'],
};
