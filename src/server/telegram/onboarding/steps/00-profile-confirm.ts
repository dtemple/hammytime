import { InlineKeyboard } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import { upsertProfileSection } from '../memory';
import { stravaConnectUrl } from '../../bot';
import { US_ZONES, ianaForKey } from '../timezones';
import type { OnboardingStep, StepHandleResult } from '../types';

// Beat A1 (onboarding v2): confirm the name + timezone derived from Strava.
// Entered by resumeAfterStrava (not the dispatcher), which seeds partial with the
// Strava-derived values and sets sub_step to 'confirm_name' or 'ask_name'.
// 'awaiting_strava' is the pre-connect state seeded at /start (beat A0).
// 'ask_timezone' is the picker shown after a name is captured via "Not quite" (or
// the no-Strava-name path); only "Yep" skips it, since that confirms the timezone.
export type ProfileConfirmPartial = {
  sub_step: 'awaiting_strava' | 'confirm_name' | 'ask_name' | 'ask_timezone';
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

const TZ_PROMPT = "Got it. Which timezone are you in? I'll use it to time your check-ins.";

function check(active: boolean): string {
  return active ? '✅ ' : '';
}

// Two-per-row timezone picker, pre-checking whichever zone Strava already derived.
function timezoneKeyboard(currentTz: string | null | undefined): InlineKeyboard {
  const kb = new InlineKeyboard();
  US_ZONES.forEach((z, i) => {
    const short = z.label.replace(' time', '');
    kb.text(`${check(z.iana === currentTz)}${short}`, `profile:tz:${z.key}`);
    if (i === 1) kb.row();
  });
  return kb.row().text('Somewhere else', 'profile:tz:keep');
}

// Stash the captured name and advance to the timezone picker.
function askTimezone(p: ProfileConfirmPartial, name: string): StepHandleResult {
  return {
    done: false,
    newPartial: { ...p, name, sub_step: 'ask_timezone' },
    reply: TZ_PROMPT,
    replyMarkup: timezoneKeyboard(p.strava_timezone),
  };
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

  // The timezone step expects a button tap; a typed message just re-shows the picker
  // (and must not be mistaken for a name, which would clobber the captured one).
  if (p.sub_step === 'ask_timezone') {
    return {
      done: false,
      newPartial: partialRaw,
      reply: TZ_PROMPT,
      replyMarkup: timezoneKeyboard(p.strava_timezone),
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

  return askTimezone(p, name);
}

async function handleCallback(
  data: string,
  partialRaw: Record<string, unknown>,
): Promise<StepHandleResult> {
  const p = asPartial(partialRaw);

  // Confirmed as-is: take the Strava name, keep the derived timezone.
  if (data === 'profile:yep' && p.sub_step === 'confirm_name') {
    return { done: true, newPartial: { ...p, name: p.strava_firstname ?? undefined } };
  }

  // "Not quite": fix the name first (or keep it), then move on to the timezone.
  if (data === 'profile:fix' && p.sub_step === 'confirm_name') {
    return {
      done: false,
      newPartial: { ...p, sub_step: 'ask_name' },
      reply: 'No problem — what should I call you?',
      replyMarkup: new InlineKeyboard().text(`Keep ${p.strava_firstname ?? 'it'}`, 'profile:keepname'),
    };
  }

  // Keep the Strava name, jump straight to the timezone picker.
  if (data === 'profile:keepname' && p.sub_step === 'ask_name') {
    return askTimezone(p, (p.strava_firstname ?? '').trim());
  }

  // Timezone picked (or "Somewhere else", which keeps the Strava-derived zone).
  if (data.startsWith('profile:tz:') && p.sub_step === 'ask_timezone') {
    const key = data.slice('profile:tz:'.length);
    if (key === 'keep') {
      return { done: true, newPartial: { ...p } };
    }
    return { done: true, newPartial: { ...p, strava_timezone: ianaForKey(key) ?? p.strava_timezone ?? null } };
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
