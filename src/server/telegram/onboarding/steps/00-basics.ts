import { supabaseAdmin } from '@/lib/db';
import { upsertProfileSection } from '../memory';
import type { OnboardingStep, ParseResult, Question } from '../types';

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

const TZ_ALIASES: Record<string, string> = {
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  pt: 'America/Los_Angeles',
  mst: 'America/Denver',
  mdt: 'America/Denver',
  mt: 'America/Denver',
  cst: 'America/Chicago',
  cdt: 'America/Chicago',
  ct: 'America/Chicago',
  est: 'America/New_York',
  edt: 'America/New_York',
  et: 'America/New_York',
  // Major cities / regions
  'new york': 'America/New_York',
  nyc: 'America/New_York',
  'new york city': 'America/New_York',
  chicago: 'America/Chicago',
  denver: 'America/Denver',
  phoenix: 'America/Phoenix',
  la: 'America/Los_Angeles',
  'los angeles': 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  sf: 'America/Los_Angeles',
  seattle: 'America/Los_Angeles',
  portland: 'America/Los_Angeles',
  boston: 'America/New_York',
  miami: 'America/New_York',
  atlanta: 'America/New_York',
  dallas: 'America/Chicago',
  houston: 'America/Chicago',
  austin: 'America/Chicago',
  minneapolis: 'America/Chicago',
  'salt lake': 'America/Denver',
  'salt lake city': 'America/Denver',
  slc: 'America/Denver',
  vegas: 'America/Los_Angeles',
  'las vegas': 'America/Los_Angeles',
  honolulu: 'Pacific/Honolulu',
  hawaii: 'Pacific/Honolulu',
  anchorage: 'America/Anchorage',
  alaska: 'America/Anchorage',
};

function isValidIANA(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseTimezone(raw: string): ParseResult<string> {
  const key = raw.trim().toLowerCase();
  if (TZ_ALIASES[key]) return { ok: true, value: TZ_ALIASES[key] };
  // Try as-is (valid IANA string)
  if (isValidIANA(raw.trim())) return { ok: true, value: raw.trim() };
  return {
    ok: false,
    error:
      'Couldn\'t match that timezone. Try something like "PST", "America/Chicago", or "New York".',
  };
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

const nameQuestion: Question<string> = {
  key: 'name',
  prompt: "What's your name?",
  parseReply(text) {
    const v = text.trim();
    if (v.length === 0) return { ok: false, error: "Name can't be blank." };
    if (v.length > 60) return { ok: false, error: 'Keep it under 60 characters.' };
    return { ok: true, value: v };
  },
};

const ageQuestion: Question<number> = {
  key: 'age',
  prompt: 'How old are you?',
  parseReply(text) {
    const n = parseInt(text.trim(), 10);
    if (isNaN(n) || String(n) !== text.trim())
      return { ok: false, error: 'Send your age as a number.' };
    if (n < 13 || n > 100) return { ok: false, error: 'Age must be between 13 and 100.' };
    return { ok: true, value: n };
  },
};

const sexQuestion: Question<string> = {
  key: 'sex',
  prompt: 'Sex — M, F, or other?',
  parseReply(text) {
    const v = text.trim().toLowerCase();
    if (v === 'm' || v === 'male') return { ok: true, value: 'M' };
    if (v === 'f' || v === 'female') return { ok: true, value: 'F' };
    // Anything else maps to "other"
    return { ok: true, value: 'other' };
  },
};

const timezoneQuestion: Question<string> = {
  key: 'timezone',
  prompt: 'What\'s your timezone? (e.g. PST, EST, America/Denver, or a city like "Chicago")',
  parseReply(text) {
    return parseTimezone(text);
  },
};

const daysPerWeekQuestion: Question<number> = {
  key: 'days_per_week',
  prompt: 'How many days per week are you available to train? (3–7)',
  parseReply(text) {
    const n = parseInt(text.trim(), 10);
    if (isNaN(n) || String(n) !== text.trim())
      return { ok: false, error: 'Send a number between 3 and 7.' };
    if (n < 3 || n > 7) return { ok: false, error: 'That needs to be between 3 and 7 days.' };
    return { ok: true, value: n };
  },
};

const hoursPerWeekQuestion: Question<number> = {
  key: 'hours_per_week',
  prompt: 'How many hours per week total are you comfortable with? (3–20)',
  parseReply(text) {
    const n = parseInt(text.trim(), 10);
    if (isNaN(n) || String(n) !== text.trim())
      return { ok: false, error: 'Send a number between 3 and 20.' };
    if (n < 3 || n > 20) return { ok: false, error: 'That needs to be between 3 and 20 hours.' };
    return { ok: true, value: n };
  },
};

// ---------------------------------------------------------------------------
// Step definition
// ---------------------------------------------------------------------------

export const basicsStep: OnboardingStep = {
  id: 'basics',
  questions: [
    nameQuestion,
    ageQuestion,
    sexQuestion,
    timezoneQuestion,
    daysPerWeekQuestion,
    hoursPerWeekQuestion,
  ],
  async onComplete(athleteId, partial) {
    const name = partial.name as string;
    const age = partial.age as number;
    const sex = partial.sex as string;
    const timezone = partial.timezone as string;
    const daysPerWeek = partial.days_per_week as number;
    const hoursPerWeek = partial.hours_per_week as number;

    const currentYear = new Date().getFullYear();
    const dob = `${currentYear - age}-01-01`;

    const { error } = await supabaseAdmin()
      .from('athletes')
      .update({ name, dob, sex, timezone, updated_at: new Date().toISOString() })
      .eq('id', athleteId);

    if (error) throw new Error(`basics onComplete DB update failed: ${error.message}`);

    const sexLabel = sex === 'M' ? 'Male' : sex === 'F' ? 'Female' : 'Other';

    await upsertProfileSection(
      athleteId,
      'Identity',
      `Name: ${name}\nAge: ${age}\nSex: ${sexLabel}\nTimezone: ${timezone}`,
    );

    await upsertProfileSection(
      athleteId,
      'Schedule',
      `Training days per week: ${daysPerWeek}\nHours per week: ${hoursPerWeek}`,
    );
  },
};
