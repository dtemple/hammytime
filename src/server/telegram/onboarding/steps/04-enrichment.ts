import { InlineKeyboard } from 'grammy';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/db';
import { anthropicClient } from '@/lib/anthropic';
import { upsertProfileSection } from '../memory';
import { formatFinishTime } from '../parsing/durations';
import type { OnboardingStep, StepHandleResult } from '../types';

// Phase C (onboarding v2): the optional freeform/voice "dump". One message → inline
// Haiku extraction with stated/inferred/unknown provenance → echo back for
// confirmation. Voice already works (handleInboundVoice transcribes upstream).
// This is the terminal step in W2: the plan preview (B1) lands in W4 before it.

const STUB =
  "You're all set — I've got enough to start. I'm putting your plan together; I'll have it for you shortly. " +
  'Talk to me anytime in the meantime.';

const Provenance = z.enum(['stated', 'inferred', 'unknown']);
const Field = z.object({ value: z.union([z.string(), z.number(), z.null()]), provenance: Provenance });

const EnrichmentSchema = z.object({
  age: z.object({ value: z.number().nullable(), provenance: Provenance }),
  target_time_sec: z.object({ value: z.number().nullable(), provenance: Provenance }),
  tuneup_races: z.array(z.object({ name: z.string(), date: z.string().nullable(), provenance: Provenance })),
  schedule_notes: Field,
  gear_notes: Field,
  motivation: Field,
});

type Extracted = z.infer<typeof EnrichmentSchema>;

type EnrichmentPartial = {
  sub_step: 'awaiting_dump' | 'confirm';
  extracted?: Extracted;
  raw?: string;
  attempts?: number;
};

function asPartial(p: Record<string, unknown>): EnrichmentPartial {
  return Object.keys(p).length === 0 ? { sub_step: 'awaiting_dump' } : (p as EnrichmentPartial);
}

const INITIAL_PROMPT = [
  'Last thing — I coach better the more I know. Tell me a few things, however you want (type or voice):',
  '• a time or distance goal, if you have one',
  '• tune-up races you have your eye on',
  '• your age',
  '• schedule, gear, anything you would tell a coach',
  '',
  'Or tap Skip.',
].join('\n');

const ENRICHMENT_TOOL = {
  name: 'extract_enrichment',
  description: "Extract optional coaching context from an athlete's freeform message.",
  input_schema: {
    type: 'object' as const,
    required: ['age', 'target_time_sec', 'tuneup_races', 'schedule_notes', 'gear_notes', 'motivation'],
    properties: {
      age: provObj('number', 'Age in years, or null'),
      target_time_sec: provObj('number', 'Goal finish time in seconds, or null'),
      tuneup_races: {
        type: 'array',
        description: 'Tune-up / warm-up races mentioned',
        items: {
          type: 'object',
          required: ['name', 'date', 'provenance'],
          properties: {
            name: { type: 'string' },
            date: { type: 'string', description: 'ISO YYYY-MM-DD or null' },
            provenance: provEnum(),
          },
        },
      },
      schedule_notes: provObj('string', 'Schedule constraints / when they run, or null'),
      gear_notes: provObj('string', 'Shoes, watch, gear, or null'),
      motivation: provObj('string', 'Why they run / tone, or null'),
    },
  },
} as const;

function provEnum() {
  return { type: 'string', enum: ['stated', 'inferred', 'unknown'] };
}
function provObj(valueType: string, desc: string) {
  return {
    type: 'object',
    required: ['value', 'provenance'],
    properties: {
      value: { type: [valueType, 'null'], description: desc },
      provenance: provEnum(),
    },
  };
}

const SYSTEM = [
  "Extract optional coaching context from the athlete's message into the tool schema.",
  'Tag provenance per field: "stated" only when the athlete said it explicitly; "inferred" for a',
  'reasonable deduction (e.g. "I run before work" → schedule inferred early-morning); "unknown" with',
  'a null value when not mentioned. Never invent a value. Do NOT extract injuries, pain, asthma, or any',
  'medical/safety detail — those are handled elsewhere. Messages may be voice-transcribed, so read',
  'disfluent text generously.',
].join(' ');

async function extract(text: string): Promise<Extracted | null> {
  try {
    const client = anthropicClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client.messages as any).create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: SYSTEM,
      tools: [ENRICHMENT_TOOL],
      tool_choice: { type: 'tool', name: 'extract_enrichment' },
      messages: [{ role: 'user', content: text }],
    });
    const toolUse = (response.content as unknown[]).find(
      (b: unknown) => (b as { type?: string }).type === 'tool_use',
    ) as { input?: unknown } | undefined;
    if (!toolUse?.input) return null;
    const parsed = EnrichmentSchema.safeParse(toolUse.input);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Build the human echo from stated + inferred fields only (skip unknown).
function buildEcho(e: Extracted): string[] {
  const bits: string[] = [];
  if (e.age.provenance !== 'unknown' && e.age.value != null) bits.push(`${e.age.value}`);
  if (e.target_time_sec.provenance !== 'unknown' && typeof e.target_time_sec.value === 'number') {
    bits.push(`goal ${formatFinishTime(e.target_time_sec.value)}`);
  }
  for (const t of e.tuneup_races) {
    if (t.provenance !== 'unknown') bits.push(t.date ? `${t.name} (${t.date})` : t.name);
  }
  for (const f of [e.schedule_notes, e.gear_notes, e.motivation]) {
    if (f.provenance !== 'unknown' && typeof f.value === 'string' && f.value.trim()) bits.push(f.value.trim());
  }
  return bits;
}

async function handleMessage(
  text: string,
  partialRaw: Record<string, unknown>,
): Promise<StepHandleResult> {
  const p = asPartial(partialRaw);

  if (p.sub_step === 'confirm') {
    return {
      done: false,
      newPartial: p,
      reply: "Tap All correct, or Let me fix something.",
    };
  }

  // awaiting_dump
  const extracted = await extract(text);
  const echo = extracted ? buildEcho(extracted) : [];

  if (!extracted || echo.length === 0) {
    // Nothing structured to confirm — keep the raw text as background and finish.
    return {
      done: true,
      newPartial: { ...p, raw: text.trim(), extracted: extracted ?? undefined },
      reply: STUB,
    };
  }

  return {
    done: false,
    newPartial: { ...p, sub_step: 'confirm', extracted, raw: text.trim() },
    reply: `Got it — ${echo.join(', ')}. Anything off?`,
    replyMarkup: new InlineKeyboard()
      .text('All correct', 'enrich:correct')
      .text('Let me fix something', 'enrich:fix'),
  };
}

async function handleCallback(
  data: string,
  partialRaw: Record<string, unknown>,
): Promise<StepHandleResult> {
  const p = asPartial(partialRaw);

  if (data === 'enrich:skip') {
    return { done: true, newPartial: { sub_step: 'awaiting_dump' }, reply: STUB };
  }
  if (data === 'enrich:correct') {
    return { done: true, newPartial: p, reply: STUB };
  }
  if (data === 'enrich:fix') {
    return {
      done: false,
      newPartial: { ...p, sub_step: 'awaiting_dump' },
      reply: 'No problem — tell me again and I will redo it.',
    };
  }
  return { done: false, newPartial: p };
}

async function onComplete(athleteId: string, partialRaw: Record<string, unknown>): Promise<void> {
  const p = partialRaw as EnrichmentPartial;
  const e = p.extracted;
  if (!e && !p.raw) return; // Skipped.

  // Provenance-tagged memory prose for the daily coach + W5 gap-tracker.
  const lines: string[] = [];
  const tag = (prov: string) => (prov === 'inferred' ? ' (inferred)' : prov === 'stated' ? ' (stated)' : '');
  if (e) {
    if (e.age.provenance !== 'unknown' && e.age.value != null) lines.push(`- Age: ${e.age.value}${tag(e.age.provenance)}`);
    if (e.target_time_sec.provenance !== 'unknown' && typeof e.target_time_sec.value === 'number')
      lines.push(`- Goal time: ${formatFinishTime(e.target_time_sec.value)}${tag(e.target_time_sec.provenance)}`);
    for (const t of e.tuneup_races) {
      if (t.provenance !== 'unknown') lines.push(`- Tune-up: ${t.name}${t.date ? ` (${t.date})` : ''}${tag(t.provenance)}`);
    }
    for (const [label, f] of [['Schedule', e.schedule_notes], ['Gear', e.gear_notes], ['Motivation', e.motivation]] as const) {
      if (f.provenance !== 'unknown' && typeof f.value === 'string' && f.value.trim())
        lines.push(`- ${label}: ${f.value.trim()}${tag(f.provenance)}`);
    }
  }
  if (lines.length === 0 && p.raw) lines.push(`- Notes: ${p.raw}`);
  if (lines.length > 0) await upsertProfileSection(athleteId, 'Background', lines.join('\n'));

  if (!e) return;

  const db = supabaseAdmin();

  // Stated-only structured backfill (never an inferred safety field).
  if (e.age.provenance === 'stated' && typeof e.age.value === 'number') {
    const birthYear = new Date().getFullYear() - e.age.value;
    await db.from('athletes').update({ dob: `${birthYear}-01-01` }).eq('id', athleteId);
  }

  if (e.target_time_sec.provenance === 'stated' && typeof e.target_time_sec.value === 'number') {
    const { data: race } = await db
      .from('races')
      .select('id')
      .eq('athlete_id', athleteId)
      .eq('status', 'upcoming')
      .order('date', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (race) {
      await db
        .from('races')
        .update({ target_type: 'time', target_time_sec: e.target_time_sec.value })
        .eq('id', race.id);
    }
  }
}

export const enrichmentStep: OnboardingStep = {
  id: 'enrichment',
  questions: [],
  initialPrompt: INITIAL_PROMPT,
  initialKeyboard: new InlineKeyboard().text('Skip', 'enrich:skip'),
  handleMessage,
  handleCallback,
  onComplete,
};
