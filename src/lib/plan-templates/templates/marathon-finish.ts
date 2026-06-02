// Example template — marathon-finish (onboarding v2, W3).
//
// First-marathon / finish goal. Selected for marathon × {beginner, for_fun,
// some_training}. Conservative: effort-led (no goal pace), <=1 quality day,
// long-run capped ~20mi, bodyweight strength. This file exists to prove the
// PlanTemplate shape is fillable and to anchor review — the other five follow
// the same shape. NUMBERS ARE DRAFT and move with the safety-cap decision.

import type { PlanTemplate } from '../types';

export const marathonFinish: PlanTemplate = {
  id: 'marathon-finish',
  label: 'Marathon — finish',
  distances: ['marathon'],
  band: 'foundation',
  appliesToTiers: ['beginner', 'for_fun', 'some_training'],

  // Phases (no cutback entry — the renderer relabels every 4th week as cutback).
  phases: [
    {
      name: 'base',
      weight: 0.25,
      minWeeks: 3,
      maxWeeks: 6,
      openEndedKeep: true,
      description: 'Aerobic foundation; settle into structure and the long-run habit.',
    },
    {
      name: 'build',
      weight: 0.45,
      minWeeks: 4,
      openEndedKeep: true,
      description: 'Progressive volume; long run grows toward the cap.',
    },
    {
      name: 'peak',
      weight: 0.2,
      minWeeks: 2,
      maxWeeks: 4,
      openEndedKeep: false,
      description: 'Highest volume; longest long runs; race-specific endurance.',
    },
    {
      name: 'taper',
      weight: 0.1,
      minWeeks: 2,
      maxWeeks: 3,
      openEndedKeep: false,
      description: 'Cut volume, hold a little intensity, arrive fresh.',
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

  // DRAFT volumes — finish-marathon bands.
  volume: {
    startVolumeFloorMi: 15,
    peakVolumeCapMi: 40,
    peakMultiplierMax: 1.8,
    longRun: {
      startAnchor: 'strava_longest',
      capMi: 20,
      weeklyStepMi: 2,
      postCutbackStepMi: 3,
      shareOfWeeklyMax: 0.35,
    },
  },

  // Run-day roles by run-days/week. Foundation marathon supports 3–5 run days;
  // the renderer rotates so 'long_run' lands on the athlete's long-run day.
  microcycles: {
    3: ['long_run', 'easy', 'quality'],
    4: ['long_run', 'easy', 'easy_with_strides', 'quality'],
    5: ['long_run', 'easy', 'easy', 'easy_with_strides', 'quality'],
  },

  // One light quality day; effort-led, no goal pace.
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
      tempoBlockMin: [12, 20],
      description: 'Comfortably-hard tempo block off an easy warm-up.',
    },
    {
      id: 'rolling-hills',
      dayType: 'hill_repeats',
      phases: ['build', 'peak'],
      warmupMin: 10,
      cooldownMin: 10,
      repeats: [4, 6],
      repeatDurationSec: 60,
      recovery: 'walk/jog down',
      description: 'Short rolling-hill repeats for strength without sharpness.',
    },
  ],

  paceModel: { primary: 'effort', deriveFromTarget: false, derivation: 'none' },

  strength: {
    defaultSessionsByTier: { beginner: 1, for_fun: 1, some_training: 2, experienced: 2 },
    placement: 'combine_with_easy_day',
    defaultEquipment: 'bodyweight_only',
    // Bodyweight-first library (no equipment) — usable before the
    // strength_equipment known gap is filled. Durations from the canonical plan.
    sessions: {
      lower_body: {
        standard_duration_min: 30,
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
        standard_duration_min: 30,
        taper_duration_min: 20,
        race_week_duration_min: 15,
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

  // Effort-led pace zones (no concrete paces — finish goal). Compliance rules
  // here are the marathon-finish subset; the renderer merges the shared base.
  guidanceBase: {
    description: 'Effort-led finish-marathon guidance.',
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
        rule_id: 'long_run_progression',
        description: 'Long run should not jump more than ~2 miles week over week.',
        max_increase_miles: 2,
        exception: 'Week after a cutback may increase up to 3 miles.',
        action: 'If the athlete ran much longer than planned, warn about injury risk.',
      },
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
      weather_disruption: 'Treadmill is fine; add incline for the quality day.',
    },
  },

  // time_goal is renderer-capable here, but eligibility is gated by selector
  // policy (timeGoalEligibility): only some_training opts in, and discouraged.
  supportsOverlays: ['trail', 'injury', 'open_ended', 'time_goal'],
};
