// Template — ultra-50k (onboarding v4, W4 / ULTRA_SUPPORT U1).
//
// A 50k is a long trail marathon, structurally — so it rides the existing renderer
// with a thin template rather than new machinery (back-to-back long runs and
// time-on-feet are the 50mi+ U2 work, not this). Effort-led throughout: trail paces
// don't map through Riegel, so a stated time is reference for race strategy, not a
// pace driver — the time_goal overlay is left OFF (timeGoalEligibility returns
// ineligible for this template). Long run caps at 26 (a marathon-distance day is the
// ceiling for the bucket); peak ~60 mi/wk. Most 50ks are trail, so the trail overlay
// is effectively default via deriveTerrain. No hard tier gate — a beginner naming a
// 50k selects this; the intake surfaces the mismatch through the safety-contradiction
// confirm, not a wall. DRAFT volume/cap numbers per ULTRA_SUPPORT §3.3–§3.4.

import type { PlanTemplate } from '../types';

export const ultra50k: PlanTemplate = {
  id: 'ultra-50k',
  label: 'Ultra — 50k',
  distances: ['50k'],
  band: 'performance',
  appliesToTiers: ['beginner', 'for_fun', 'some_training', 'experienced'],

  phases: [
    {
      name: 'base',
      weight: 0.2,
      minWeeks: 3,
      maxWeeks: 6,
      openEndedKeep: true,
      description: 'Aerobic base and time on feet; settle the long-run habit on trail.',
    },
    {
      name: 'build',
      weight: 0.4,
      minWeeks: 5,
      openEndedKeep: true,
      description: 'Volume climbs; the long run grows and starts carrying real vert and fuel.',
    },
    {
      name: 'peak',
      weight: 0.25,
      minWeeks: 3,
      maxWeeks: 5,
      openEndedKeep: false,
      description: 'Biggest weeks; longest long runs on race-like terrain, fueling dialed.',
    },
    {
      name: 'taper',
      weight: 0.1,
      minWeeks: 2,
      maxWeeks: 3,
      openEndedKeep: false,
      description: 'Pull the volume back, keep the legs sharp, arrive fresh.',
    },
    {
      name: 'race',
      weight: 0,
      minWeeks: 1,
      maxWeeks: 1,
      openEndedKeep: false,
      description: 'Race week — easy running, rested and ready.',
    },
  ],

  cutback: { everyNWeeks: 4, volumePct: 0.8 },

  // DRAFT volumes — 50k bands (ULTRA_SUPPORT §3.3–§3.4). Higher floor and ceiling
  // than the marathon; the long run tops out at marathon distance.
  volume: {
    startVolumeFloorMi: 30,
    peakVolumeCapMi: 60,
    peakMultiplierMax: 1.6,
    longRun: {
      startAnchor: 'strava_longest',
      capMi: 26,
      weeklyStepMi: 2,
      postCutbackStepMi: 3,
      shareOfWeeklyMax: 0.45,
    },
  },

  // Effort-led week; one quality day until 6 run-days (then two). The renderer
  // rotates the long run onto the athlete's day and spaces the hard days.
  microcycles: {
    3: ['long_run', 'easy', 'quality'],
    4: ['long_run', 'easy', 'easy_with_strides', 'quality'],
    5: ['long_run', 'easy', 'easy', 'easy_with_strides', 'quality'],
    6: ['long_run', 'easy', 'easy', 'easy_with_strides', 'quality', 'quality'],
  },

  // Strength-oriented, effort-led — no goal pace. Hills and tempo build trail
  // durability; the trail overlay turns tempo into trail tempo.
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
      tempoBlockMin: [15, 25],
      description: 'Comfortably-hard tempo block off an easy warm-up.',
    },
    {
      id: 'rolling-hills',
      dayType: 'hill_repeats',
      phases: ['build', 'peak'],
      warmupMin: 12,
      cooldownMin: 10,
      repeats: [5, 8],
      repeatDurationSec: 75,
      recovery: 'walk/jog down',
      description: 'Hill repeats for climbing strength — the engine an ultra runs on.',
    },
  ],

  paceModel: { primary: 'effort', deriveFromTarget: false, derivation: 'none' },

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

  // Effort-led zones — no concrete paces. The note carries the ultra framing the
  // daily coach needs so a 60-mile week and a hike mid-long-run aren't read as
  // anomalies.
  guidanceBase: {
    pace_zones: {
      note: 'Ultra — lead with heart rate and effort, never pace. Higher weekly volume is the point; hiking the steep climbs is training, not quitting; fueling on the long runs is a session goal in its own right.',
      easy: {
        description: 'Conversational; full sentences.',
        hr_zone: [1, 2],
        rpe: [3, 5],
      },
      long_run: {
        description: 'Mostly easy; time on feet over pace. Hike the steep stuff, eat and drink on schedule.',
        hr_zone: [1, 3],
        rpe: [3, 6],
      },
      tempo: {
        description: 'Comfortably hard; short phrases only.',
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
        description: 'Easy and long runs should stay in zone 1–2.',
        condition: 'avg_hr_percent_max > 75 on easy or long_run',
        action: 'Advise slowing down — on a high-volume block, easy has to be truly easy.',
      },
      {
        rule_id: 'fueling_practice',
        description: 'The long runs are where race-day fueling and hiking get rehearsed.',
        action: 'If long runs are getting skipped or cut short, that is the thread to pull — the distance is built on them.',
      },
    ],
    modification_triggers: {
      feeling_great:
        'Hold the plan; resist stacking extra long-run distance late. The cap is there on purpose.',
      feeling_fatigued:
        'Drop the quality day to easy, keep the long run but slow it and shorten ~20% if needed.',
      time_crunched: 'Priority: long run > quality day > strength > second easy run.',
      weather_disruption:
        'Keep the long run outside if at all possible — terrain time is the point; move tempo work indoors if you must.',
    },
  },

  supportsOverlays: ['trail', 'injury', 'open_ended'],
};
