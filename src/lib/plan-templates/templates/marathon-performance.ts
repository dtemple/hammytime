// Template — marathon-performance (onboarding v2, W3).
//
// Experienced marathoner chasing a time. Selected for marathon × experienced.
// Pace-led (goal pace derived from the target time via Riegel), two quality days
// (threshold + VO2), marathon-pace segments in the long run, long run capped ~22.
// Carries the `time_goal` overlay open (no discouragement at this tier).

import type { PlanTemplate } from '../types';

export const marathonPerformance: PlanTemplate = {
  id: 'marathon-performance',
  label: 'Marathon — performance',
  distances: ['marathon'],
  band: 'performance',
  appliesToTiers: ['experienced'],

  phases: [
    {
      name: 'base',
      weight: 0.2,
      minWeeks: 3,
      maxWeeks: 6,
      openEndedKeep: true,
      description: 'Aerobic base and a return to structure; ease the quality back in.',
    },
    {
      name: 'build',
      weight: 0.4,
      minWeeks: 5,
      openEndedKeep: true,
      description: 'Progressive volume with threshold and VO2 work; long run grows.',
    },
    {
      name: 'peak',
      weight: 0.25,
      minWeeks: 3,
      maxWeeks: 5,
      openEndedKeep: false,
      description: 'Highest volume; marathon-pace long runs; race-specific sharpening.',
    },
    {
      name: 'taper',
      weight: 0.1,
      minWeeks: 2,
      maxWeeks: 3,
      openEndedKeep: false,
      description: 'Cut volume, hold intensity, sharpen and freshen for race day.',
    },
    {
      name: 'race',
      weight: 0,
      minWeeks: 1,
      maxWeeks: 1,
      openEndedKeep: false,
      description: 'Race week — minimal running, primed and rested.',
    },
  ],

  cutback: { everyNWeeks: 4, volumePct: 0.8 },

  volume: {
    startVolumeFloorMi: 25,
    peakVolumeCapMi: 55,
    peakMultiplierMax: 1.6,
    longRun: {
      startAnchor: 'strava_longest',
      capMi: 22,
      weeklyStepMi: 2,
      postCutbackStepMi: 3,
      shareOfWeeklyMax: 0.4,
    },
  },

  // Two quality days from 5 run-days up; the renderer rotates the long run onto
  // the athlete's chosen day and spaces the hard days.
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
      warmupMin: 12,
      cooldownMin: 10,
      tempoBlockMin: [20, 40],
      description: 'Sustained threshold block — comfortably hard, controlled.',
    },
    {
      id: 'vo2-intervals',
      dayType: 'intervals',
      phases: ['build', 'peak'],
      warmupMin: 15,
      cooldownMin: 10,
      repeats: [4, 6],
      repeatDistanceM: 1000,
      recovery: '2–3 min easy jog',
      description: 'VO2 intervals — 1k reps at 5k–10k effort.',
    },
    {
      id: 'strides',
      dayType: 'easy_with_strides',
      phases: ['base', 'build'],
      strides: { count: [4, 8], durationSec: 20, recovery: 'full jog back' },
      description: 'Easy run + relaxed strides to keep the legs quick.',
    },
  ],

  paceModel: { primary: 'pace', deriveFromTarget: true, derivation: 'riegel' },

  strength: {
    defaultSessionsByTier: { beginner: 1, for_fun: 1, some_training: 2, experienced: 2 },
    placement: 'combine_with_easy_day',
    defaultEquipment: 'bodyweight_only',
    sessions: {
      lower_body: {
        standard_duration_min: 35,
        taper_duration_min: 20,
        race_week_duration_min: 15,
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
        standard_duration_min: 30,
        taper_duration_min: 20,
        race_week_duration_min: 15,
        exercises: [
          { name: 'Push-ups', sets: 3, reps: 15 },
          {
            name: 'Dead bugs',
            exercise_slug: 'dead-bug',
            sets: 3,
            reps: 12,
            reps_unit: 'per_side',
          },
          { name: 'Plank', exercise_slug: 'front-plank', sets: 3, reps: 60, reps_unit: 'seconds' },
        ],
      },
    },
  },

  guidanceBase: {
    pace_zones: {
      note: 'Time goal — easy stays easy by effort; quality and race-pace work lead on pace.',
      easy: {
        description: 'Conversational; full sentences.',
        hr_zone: [1, 2],
        rpe: [3, 5],
      },
      long_run: {
        description: 'Mostly easy; marathon-pace segments layered in during the build.',
        hr_zone: [1, 3],
        rpe: [3, 6],
      },
      tempo: {
        description: 'Threshold — comfortably hard, short phrases only.',
        hr_zone: [3, 4],
        rpe: [6, 8],
      },
      interval: {
        description: 'VO2 reps — hard, near top sustainable effort.',
        hr_zone: [4, 5],
        rpe: [8, 9],
      },
      marathon_pace: {
        description: 'Goal race pace — steady, repeatable, on the edge of comfortable.',
        hr_zone: [3, 4],
        rpe: [6, 7],
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
        description: 'Easy and recovery runs should stay in zone 1–2 even with a time goal.',
        condition: 'avg_hr_percent_max > 78 on easy or recovery runs',
        action: 'Slow the easy days down — quality only works if the easy is truly easy.',
      },
      {
        rule_id: 'goal_pace_realism',
        description: 'Goal pace should track the athlete’s recent fitness, not an aspiration.',
        action: 'If race-pace work is consistently failing, revisit the goal time with them.',
      },
    ],
    modification_triggers: {
      feeling_great:
        'Hold the plan; resist adding volume late in the build. Extra freshness is the point of the taper.',
      feeling_fatigued:
        'Drop one quality day to easy this week, keep the long run but cut any marathon-pace segment.',
      time_crunched: 'Priority: quality day > long run > second quality > strength > easy run.',
      weather_disruption:
        'Move threshold work indoors; keep the long run outside if at all possible.',
    },
  },

  supportsOverlays: ['trail', 'injury', 'open_ended', 'time_goal'],
};
