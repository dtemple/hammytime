import { InlineKeyboard } from 'grammy';
import { getFitnessSnapshot } from '@/server/strava/activities';
import { upsertProfileSection } from '../memory';
import { upsertTrainingProfile, type ExperienceTier } from '../athlete-training-profile';
import type { OnboardingStep, StepHandleResult } from '../types';

// Beats A3 (experience tier) + A5 (days/week) + A6 (long-run day). One step, three
// button screens. Days/week and long-run day are pre-suggested from the Strava
// fitness snapshot and overridable. Experience tier is a plain choice; Strava
// volume is a poor proxy for how someone describes their own training level.

type ShapePartial = {
  sub_step: 'experience' | 'days' | 'long_run';
  experience_tier?: ExperienceTier;
  days_per_week?: number;
  suggested_days?: number;
  suggested_long_run?: number | null;
};

function asPartial(p: Record<string, unknown>): ShapePartial {
  return Object.keys(p).length === 0 ? { sub_step: 'experience' } : (p as ShapePartial);
}

const TIERS: { key: ExperienceTier; label: string }[] = [
  { key: 'beginner', label: 'Beginner' },
  { key: 'for_fun', label: 'Just for fun' },
  { key: 'some_training', label: 'Some training' },
  { key: 'experienced', label: 'Experienced' },
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function check(active: boolean): string {
  return active ? '✅ ' : '';
}

function experienceKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const t of TIERS) {
    kb.text(t.label, `exp:${t.key}`).row();
  }
  return kb;
}

function daysKeyboard(suggested: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const d of [3, 4, 5, 6]) {
    kb.text(`${check(d === suggested)}${d}`, `days:${d}`);
  }
  return kb;
}

function longRunKeyboard(suggested: number | null): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Sat, Sun first (most common long-run days), then the rest.
  const order = [6, 0, 1, 2, 3, 4, 5];
  order.forEach((d, i) => {
    kb.text(`${check(d === suggested)}${WEEKDAYS[d]}`, `lr:${d}`);
    if (i === 3) kb.row();
  });
  return kb;
}

// Button-only step: a typed message must not fall through to the empty-questions
// branch (which would complete the step early). Nudge the athlete to tap instead.
async function handleMessage(
  _text: string,
  partialRaw: Record<string, unknown>,
): Promise<StepHandleResult> {
  return { done: false, newPartial: partialRaw, reply: 'Tap one of the buttons above to continue.' };
}

async function handleCallback(
  data: string,
  partialRaw: Record<string, unknown>,
  athleteId: string,
): Promise<StepHandleResult> {
  const p = asPartial(partialRaw);

  if (data.startsWith('exp:')) {
    const experience_tier = data.slice('exp:'.length) as ExperienceTier;
    const snapshot = await getFitnessSnapshot(athleteId).catch(() => null);
    const suggestedDays = snapshot?.suggested_days_per_week ?? 4;
    const suggestedLr = snapshot?.dominant_long_run_weekday ?? null;
    return {
      done: false,
      newPartial: {
        ...p,
        experience_tier,
        sub_step: 'days',
        suggested_days: suggestedDays,
        suggested_long_run: suggestedLr,
      },
      reply: `Based on where you are, I'd suggest ${suggestedDays} days a week. Sound right?`,
      replyMarkup: daysKeyboard(suggestedDays),
    };
  }

  if (data.startsWith('days:')) {
    const days_per_week = parseInt(data.slice('days:'.length), 10);
    const suggestedLr = p.suggested_long_run ?? null;
    const dayName = suggestedLr != null ? WEEKDAYS[suggestedLr] : null;
    const prompt =
      dayName != null
        ? `Which day for your long run? Looks like you usually go longer on ${dayName}.`
        : "Which day for your long run?";
    return {
      done: false,
      newPartial: { ...p, days_per_week, sub_step: 'long_run' },
      reply: prompt,
      replyMarkup: longRunKeyboard(suggestedLr),
    };
  }

  if (data.startsWith('lr:')) {
    const long_run_day = parseInt(data.slice('lr:'.length), 10);
    return { done: true, newPartial: { ...p, long_run_day } as Record<string, unknown> & { long_run_day: number } };
  }

  return { done: false, newPartial: p };
}

async function onComplete(athleteId: string, partialRaw: Record<string, unknown>): Promise<void> {
  const p = partialRaw as ShapePartial & { long_run_day?: number };

  await upsertTrainingProfile(athleteId, {
    experience_tier: p.experience_tier ?? null,
    days_per_week: p.days_per_week ?? null,
    long_run_day: p.long_run_day ?? null,
  });

  const lines = [
    `- Experience: ${p.experience_tier ?? 'unknown'}`,
    `- Days/week: ${p.days_per_week ?? 'unknown'}`,
    `- Long run: ${p.long_run_day != null ? WEEKDAYS[p.long_run_day] : 'unknown'}`,
  ];
  await upsertProfileSection(athleteId, 'Schedule', lines.join('\n'));
}

export const trainingShapeStep: OnboardingStep = {
  id: 'training-shape',
  questions: [],
  initialPrompt:
    "What's your level?\n\n" +
    'Beginner: occasional runs under 5 miles\n' +
    'Just for fun: run regularly, no structure\n' +
    'Some training: 6+ mi weeks with some intervals or tempo\n' +
    'Experienced: racing half-marathons or more, structured training',
  initialKeyboard: experienceKeyboard(),
  handleMessage,
  handleCallback,
  onComplete,
};
