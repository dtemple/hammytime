// Template — base-maintenance (onboarding v2, W3).
//
// No race, no timeline — day-to-day base fitness. Selected for keep_fit × any
// tier. Open-ended by construction: only base + build phases (both
// openEndedKeep), no peak/taper/race. The renderer emits a rolling block and the
// daily coach extends or anchors it if the athlete later picks a race.

import type { PlanTemplate } from '../types';

export const baseMaintenance: PlanTemplate = {
  id: 'base-maintenance',
  label: 'Base / maintenance',
  distances: ['keep_fit'],
  band: 'maintenance',
  appliesToTiers: ['beginner', 'for_fun', 'some_training', 'experienced'],

  // Only the open-ended-kept phases. No peak/taper/race — there's nothing to peak
  // for until a race binds (then the daily coach reshapes).
  phases: [
    {
      name: 'base',
      weight: 0.4,
      minWeeks: 3,
      openEndedKeep: true,
      description: 'Aerobic base; consistent easy running and the long-run habit.',
    },
    {
      name: 'build',
      weight: 0.6,
      minWeeks: 4,
      openEndedKeep: true,
      description: 'Gently rolling volume with a single light quality day for variety.',
    },
  ],

  cutback: { everyNWeeks: 4, volumePct: 0.85 },

  volume: {
    startVolumeFloorMi: 12,
    peakVolumeCapMi: 35,
    peakMultiplierMax: 1.4,
    longRun: {
      startAnchor: 'strava_longest',
      capMi: 14,
      weeklyStepMi: 1.5,
      postCutbackStepMi: 2,
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
      description: 'Easy run + short relaxed strides to keep some pop in the legs.',
    },
    {
      id: 'gentle-tempo',
      dayType: 'tempo',
      phases: ['build'],
      tempoBlockMin: [10, 20],
      description: 'Optional comfortably-hard tempo block for variety, not racing.',
    },
  ],

  paceModel: { primary: 'effort', deriveFromTarget: false, derivation: 'none' },

  strength: {
    defaultSessionsByTier: { beginner: 1, for_fun: 1, some_training: 1, experienced: 2 },
    placement: 'combine_with_easy_day',
    defaultEquipment: 'bodyweight_only',
    sessions: {
      lower_body: {
        standard_duration_min: 25,
        taper_duration_min: 20,
        race_week_duration_min: 20,
        exercises: [
          { name: 'Single-leg calf raises', sets: 3, reps: 12, reps_unit: 'per_side' },
          { name: 'Split squats', sets: 3, reps: 10, reps_unit: 'per_leg' },
          { name: 'Glute bridges', sets: 3, reps: 15 },
          { name: 'Side planks', sets: 2, reps: 30, reps_unit: 'seconds' },
        ],
      },
      upper_body: {
        standard_duration_min: 25,
        taper_duration_min: 20,
        race_week_duration_min: 20,
        exercises: [
          { name: 'Push-ups', sets: 3, reps: 12 },
          { name: 'Dead bugs', sets: 3, reps: 10, reps_unit: 'per_side' },
          { name: 'Plank', sets: 3, reps: 45, reps_unit: 'seconds' },
        ],
      },
    },
  },

  guidanceBase: {
    description: 'Effort-led base/maintenance guidance — consistency over peaking.',
    pace_zones: {
      note: 'No race — lead with effort. Keep most running easy; one optional light quality day.',
      easy: {
        description: 'Conversational; full sentences.',
        hr_zone: [1, 2],
        hr_percent_max: [60, 75],
        rpe: [3, 5],
      },
      long_run: {
        description: 'Slightly slower than easy; time on feet, never a grind.',
        hr_zone: [1, 2],
        hr_percent_max: [60, 72],
        rpe: [3, 5],
      },
      tempo: {
        description: 'Comfortably hard; short phrases only. Optional in this block.',
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
        action: 'Advise slowing down — base is built on easy effort, not grinding.',
      },
    ],
    modification_triggers: {
      feeling_great:
        'Add a little easy volume or a stride set; there is no peak to chase, so keep it sustainable.',
      feeling_fatigued:
        'Cut volume and drop the quality day this week. Maintenance flexes around life, not the reverse.',
      time_crunched: 'Priority: long run > easy run > strength > quality.',
      weather_disruption: 'Treadmill is fine; keep efforts easy.',
    },
  },

  supportsOverlays: ['trail', 'injury', 'open_ended'],
};
