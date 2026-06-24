// Template — short-race (onboarding v2, W3).
//
// 5k and 10k, every tier. Distance is a render param (the selector passes
// goal_distance; the renderer reads the per-distance long-run ceiling — 5k 8 /
// 10k 10). Short races are pace-driven, so `time_goal` is open across all tiers,
// even beginners benefit from a goal pace. Two quality days (VO2 + tempo), low
// long-run ceiling, higher relative intensity.

import type { PlanTemplate } from '../types';

export const shortRace: PlanTemplate = {
  id: 'short-race',
  label: '5k / 10k',
  distances: ['5k', '10k'],
  band: 'development',
  appliesToTiers: ['beginner', 'for_fun', 'some_training', 'experienced'],

  phases: [
    {
      name: 'base',
      weight: 0.3,
      minWeeks: 2,
      maxWeeks: 5,
      openEndedKeep: true,
      description: 'Aerobic base and strides; prepare the legs for faster work.',
    },
    {
      name: 'build',
      weight: 0.4,
      minWeeks: 3,
      openEndedKeep: true,
      description: 'Intervals and tempo; sharpen toward race pace.',
    },
    {
      name: 'peak',
      weight: 0.2,
      minWeeks: 1,
      maxWeeks: 3,
      openEndedKeep: false,
      description: 'Race-specific speed at and around goal pace.',
    },
    {
      name: 'taper',
      weight: 0.1,
      minWeeks: 1,
      maxWeeks: 2,
      openEndedKeep: false,
      description: 'Short, sharp taper — hold the speed, drop the volume.',
    },
    {
      name: 'race',
      weight: 0,
      minWeeks: 1,
      maxWeeks: 1,
      openEndedKeep: false,
      description: 'Race week — fresh and fast.',
    },
  ],

  cutback: { everyNWeeks: 4, volumePct: 0.85 },

  volume: {
    startVolumeFloorMi: 10,
    peakVolumeCapMi: 35,
    peakMultiplierMax: 1.7,
    longRun: {
      startAnchor: 'strava_longest',
      capMi: 10, // 10k ceiling; the renderer clamps to caps.maxLongRunMiByDistance[distance]
      weeklyStepMi: 1.5,
      postCutbackStepMi: 2,
      shareOfWeeklyMax: 0.35,
    },
  },

  microcycles: {
    3: ['long_run', 'quality', 'quality'],
    4: ['long_run', 'easy', 'quality', 'quality'],
    5: ['long_run', 'easy', 'quality', 'easy_with_strides', 'quality'],
  },

  workoutMenu: [
    {
      id: 'vo2-intervals',
      dayType: 'intervals',
      phases: ['build', 'peak'],
      warmupMin: 12,
      cooldownMin: 10,
      repeats: [5, 8],
      repeatDistanceM: 400,
      recovery: '90s easy jog',
      description: 'VO2 intervals — 400m reps at mile–3k effort.',
    },
    {
      id: 'race-pace-tempo',
      dayType: 'tempo',
      phases: ['build', 'peak', 'taper'],
      warmupMin: 10,
      cooldownMin: 10,
      tempoBlockMin: [10, 20],
      description: 'Tempo / cruise intervals around goal race pace.',
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
        standard_duration_min: 25,
        taper_duration_min: 15,
        race_week_duration_min: 10,
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
            reps: 10,
            reps_unit: 'per_leg',
          },
          { name: 'Glute bridges', sets: 3, reps: 15 },
          {
            name: 'Side planks',
            exercise_slug: 'side-plank',
            sets: 2,
            reps: 35,
            reps_unit: 'seconds',
          },
        ],
      },
      upper_body: {
        standard_duration_min: 25,
        taper_duration_min: 15,
        race_week_duration_min: 10,
        exercises: [
          { name: 'Push-ups', sets: 3, reps: 12 },
          {
            name: 'Dead bugs',
            exercise_slug: 'dead-bug',
            sets: 3,
            reps: 10,
            reps_unit: 'per_side',
          },
          { name: 'Plank', exercise_slug: 'front-plank', sets: 3, reps: 45, reps_unit: 'seconds' },
        ],
      },
    },
  },

  guidanceBase: {
    pace_zones: {
      note: 'Easy stays easy by effort; intervals and tempo lead on pace, anchored to goal race pace.',
      easy: {
        description: 'Conversational; full sentences.',
        hr_zone: [1, 2],
        rpe: [3, 5],
      },
      long_run: {
        description: 'Easy aerobic support run — modest distance for a short-race plan.',
        hr_zone: [1, 2],
        rpe: [3, 5],
      },
      tempo: {
        description: 'Threshold / cruise — comfortably hard, controlled.',
        hr_zone: [3, 4],
        rpe: [6, 8],
      },
      interval: {
        description: 'VO2 / speed reps — hard, near maximal on the short ones.',
        hr_zone: [4, 5],
        rpe: [8, 10],
      },
      marathon_pace: {
        description: 'Goal race pace (5k/10k) — the target for race-pace segments.',
        hr_zone: [4, 5],
        rpe: [7, 9],
      },
      strides: {
        description: 'Short relaxed bursts; full recovery.',
        hr_zone: [4, 5],
        rpe: [7, 8],
      },
    },
    compliance_rules: [
      {
        rule_id: 'easy_pace_too_fast',
        description:
          'Easy days must stay easy — short-race plans live or die on quality-day quality.',
        condition: 'avg_hr_percent_max > 76 on easy runs',
        action: 'Slow the easy days right down so the interval and tempo days can be sharp.',
      },
    ],
    modification_triggers: {
      feeling_great:
        'Sharpen, don’t pile on — add a rep or two to intervals rather than extending easy volume.',
      feeling_fatigued:
        'Cut one quality day to easy; speed needs freshness more than endurance does.',
      time_crunched: 'Priority: interval day > tempo day > strength > easy run > long run.',
      weather_disruption:
        'Intervals move to a treadmill or track shelter fine; keep the efforts honest.',
    },
  },

  supportsOverlays: ['trail', 'injury', 'open_ended', 'time_goal'],
};
