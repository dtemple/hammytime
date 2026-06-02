import { supabaseAdmin } from '@/lib/db';
import { upsertProfileSection } from '../memory';
import { stravaConnectUrl } from '../../bot';
import type { OnboardingStep, StepHandleResult } from '../types';

// Beat A1 (onboarding v2): confirm the name + timezone derived from Strava.
// Entered by resumeAfterStrava (not the dispatcher), which seeds partial with the
// Strava-derived values and sets sub_step to 'confirm_name' or 'ask_name'.
// 'awaiting_strava' is the pre-connect state seeded at /start (beat A0).
export type ProfileConfirmPartial = {
  sub_step: 'awaiting_strava' | 'confirm_name' | 'ask_name';
  strava_firstname?: string | null;
  strava_timezone?: string | null;
  strava_sex?: 'M' | 'F' | null;
  name?: string;
};

function asPartial(p: Record<string, unknown>): ProfileConfirmPartial {
  return p as ProfileConfirmPartial;
}

function isValidName(s: string): boolean {
  const t = s.trim();
  return t.length >= 1 && t.length <= 60;
}

async function handleMessage(
  text: string,
  partialRaw: Record<string, unknown>,
  athleteId: string,
): Promise<StepHandleResult> {
  const p = asPartial(partialRaw);

  // Athlete typed before tapping Connect Strava — nudge them to the button.
  if (p.sub_step === 'awaiting_strava' || !p.sub_step) {
    return {
      done: false,
      newPartial: partialRaw,
      reply: `First connect Strava so I can read your running: ${stravaConnectUrl(athleteId)}`,
    };
  }

  // In confirm_name they tapped nothing and typed a name, or in ask_name they answered.
  const name = text.trim();
  if (!isValidName(name)) {
    return {
      done: false,
      newPartial: partialRaw,
      reply: 'What should I call you? (a name, up to 60 characters)',
    };
  }

  return { done: true, newPartial: { ...p, name } };
}

async function handleCallback(
  data: string,
  partialRaw: Record<string, unknown>,
): Promise<StepHandleResult> {
  const p = asPartial(partialRaw);

  if (data === 'profile:yep') {
    return { done: true, newPartial: { ...p, name: p.strava_firstname ?? undefined } };
  }

  if (data === 'profile:rename') {
    return {
      done: false,
      newPartial: { ...p, sub_step: 'ask_name' },
      reply: 'No problem — what should I call you?',
    };
  }

  return { done: false, newPartial: partialRaw };
}

async function onComplete(athleteId: string, partialRaw: Record<string, unknown>): Promise<void> {
  const p = asPartial(partialRaw);
  const name = (p.name ?? p.strava_firstname ?? '').trim();

  const update: { name?: string; timezone?: string; sex?: string } = {};
  if (name) update.name = name;
  if (p.strava_timezone) update.timezone = p.strava_timezone;
  if (p.strava_sex) update.sex = p.strava_sex;

  if (Object.keys(update).length > 0) {
    await supabaseAdmin().from('athletes').update(update).eq('id', athleteId);
  }

  const lines = [`- Name: ${name || 'unknown'}`];
  if (p.strava_timezone) lines.push(`- Timezone: ${p.strava_timezone}`);
  if (p.strava_sex) lines.push(`- Sex: ${p.strava_sex}`);
  await upsertProfileSection(athleteId, 'Identity', lines.join('\n'));
}

export const profileConfirmStep: OnboardingStep = {
  id: 'profile-confirm',
  questions: [],
  handleMessage,
  handleCallback,
  onComplete,
};
