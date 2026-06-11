// Onboarding v3 (V3-W2): the combined `extract_and_advance` Sonnet tool + caller.
//
// One round-trip per inbound message (ONBOARDING_V3 §5). The model reads the
// current slot state + recent conversation and returns, in a single tool call:
//   - a DELTA of slot fills (only what this message touched), each provenance-tagged;
//   - the next action (ask / confirm / recap / generate);
//   - the athlete-facing message to send, plus any chips;
//   - routing signals the deterministic layer acts on (race lookup, a flagged
//     contradiction, an unresolved numeric).
//
// The model proposes; the guardrails (guardrails.ts) dispose. next_action and any
// safety/plan-driving fill are re-checked in code before anything is sent or
// committed — the model is never trusted with the invariants (§5.4).

import { z } from 'zod';
import { anthropicClient } from '@/lib/anthropic';
import { supabaseAdmin } from '@/lib/db';
import { ProvenanceSchema } from '../slots/provenance';
import { SLOTS, SLOT_KEYS, requiredCoreSlots, type SlotKey } from '../slots/schema';
import { hasReflected, type V3OnboardingState } from '../slots/slot-state';
import { formatFinishTime } from '../parsing/durations';
import { todayISOInTz } from './numeric';
import type { HistoryTurn } from './history';

export const ONBOARDING_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;
// Sonnet 4.6 pricing, USD per million tokens (matches race-lookup.ts).
const COST_PER_M_INPUT = 3.0;
const COST_PER_M_OUTPUT = 15.0;

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export type NextAction = 'ask' | 'confirm' | 'recap' | 'generate';

const SlotKeyEnum = z.enum(SLOT_KEYS as [SlotKey, ...SlotKey[]]);

const FillSchema = z.object({
  slot: SlotKeyEnum,
  // Value typing is slot-dependent (string / number-of-seconds / {body_part,status}
  // / array); validated and coerced per-slot in guardrails.mergeFills.
  value: z.unknown(),
  provenance: ProvenanceSchema,
});
export type SlotFill = z.infer<typeof FillSchema>;

const ChipSchema = z.object({ label: z.string(), value: z.string() });
export type Chip = z.infer<typeof ChipSchema>;

export const ExtractAdvanceSchema = z.object({
  fills: z.array(FillSchema).default([]),
  next_action: z.enum(['ask', 'confirm', 'recap', 'generate']),
  message: z.string(),
  chips: z.array(ChipSchema).default([]),
  // The slot this turn is asking about (when next_action='ask') — lets the budget
  // counter know an optional question was spent.
  asked_slot: SlotKeyEnum.nullish().transform((v) => v ?? null),
  // A race name to resolve with lookupRace before confirming.
  race_lookup_query: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  // A concrete distance (miles) the athlete stated that ISN'T a standard bucket
  // — the code buckets it (or routes it to the pocket), never the model (§5.3).
  goal_distance_mi: z
    .number()
    .nullish()
    .transform((v) => v ?? null),
  // A safety-relevant cross-slot conflict to surface before plan-gen (§5.1).
  contradiction: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  // A numeric the model couldn't pin to a unit — the deterministic layer disambiguates.
  numeric_unresolved: z
    .object({ slot: SlotKeyEnum, raw: z.string() })
    .nullish()
    .transform((v) => v ?? null),
  // NEW clauses for the athlete's goal portfolio (R2) — everything stated that
  // isn't the plan-driving slots. Lenient on shape: a stray non-string entry is
  // filtered here rather than failing the whole tool call and burning the retry.
  intents: z
    .array(z.unknown())
    .nullish()
    .transform((v) => (v ?? []).filter((s): s is string => typeof s === 'string')),
  // The one-time mirror of the athlete's whole first goal statement (R2). Pure
  // reflection prose — no question, no catalog talk. The router composes it onto
  // whatever message wins the turn, so it survives overrides and the pocket.
  reflection: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});
export type ExtractAdvanceOutput = z.infer<typeof ExtractAdvanceSchema>;

// ---------------------------------------------------------------------------
// Tool schema (Anthropic JSON Schema)
// ---------------------------------------------------------------------------

const EXTRACT_TOOL = {
  name: 'extract_and_advance',
  description:
    'Record what the athlete just told you (as slot fills) and decide the next move in the onboarding conversation. Always call this — never reply in plain text.',
  input_schema: {
    type: 'object' as const,
    required: ['fills', 'next_action', 'message'],
    properties: {
      fills: {
        type: 'array',
        description:
          'ONLY the slots this latest message changed. Omit slots that did not change. Never restate the whole profile.',
        items: {
          type: 'object',
          required: ['slot', 'value', 'provenance'],
          properties: {
            slot: { type: 'string', enum: SLOT_KEYS },
            value: {
              description:
                'The value. Text/enum slots → string; target_time → integer seconds; age/days_per_week/long_run_day → integer; injury_detail → {body_part, status}; tune_up_races → array of {name, date}. null if clearing.',
            },
            provenance: {
              type: 'string',
              enum: ['stated', 'inferred', 'unknown'],
              description:
                '"stated" ONLY when the athlete said it explicitly; "inferred" for a reasonable deduction; never invent.',
            },
          },
        },
      },
      next_action: {
        type: 'string',
        enum: ['ask', 'confirm', 'recap', 'generate'],
        description:
          "'ask' for an open slot; 'confirm' to echo a safety/plan-driving fill for a yes/no; 'recap' for the full pre-plan summary; 'generate' only when every required slot is filled and the injury beat is answered.",
      },
      message: { type: 'string', description: 'The message to send the athlete. Daybreak voice.' },
      chips: {
        type: 'array',
        description:
          'The app guarantees chips for closed-option and yes/no questions (distance, the injury beat, a confirm) — leave this empty for those. Populate it only for an open question where you want to offer a shortcut the app cannot infer.',
        items: {
          type: 'object',
          required: ['label', 'value'],
          properties: {
            label: { type: 'string', description: 'Button text' },
            value: { type: 'string', description: 'The answer this chip stands for' },
          },
        },
      },
      asked_slot: {
        type: 'string',
        enum: SLOT_KEYS,
        description: "When next_action='ask', the slot you're asking about.",
      },
      race_lookup_query: {
        type: 'string',
        description: 'If the athlete named a race, the race name to look up before confirming.',
      },
      goal_distance_mi: {
        type: 'number',
        description:
          "A concrete goal distance in MILES that isn't one of the standard buckets (5k/10k/half/marathon) — e.g. '44 miles', '50k' (≈31), '100 miler'. The app maps it to a bucket or handles it specially. Don't set this if you set race_lookup_query (the lookup carries the distance), and don't guess goal_distance from a number yourself.",
      },
      contradiction: {
        type: 'string',
        description:
          'A safety-relevant conflict between slots (e.g. five weeks running + a first marathon in twelve weeks). Surface it for confirmation before generating.',
      },
      numeric_unresolved: {
        type: 'object',
        properties: { slot: { type: 'string', enum: SLOT_KEYS }, raw: { type: 'string' } },
        description: "A number whose unit you couldn't resolve — let the app disambiguate.",
      },
      intents: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Secondary goals, qualities, or standing concerns the athlete STATED that are not the plan-driving slots — e.g. "speed at shorter distances", "build muscle strength and resilience". Short clauses in the athlete\'s own words, compressed, never invented. Emit ONLY new ones this message added (the app keeps the running list and shows it to you). Injury specifics are NOT intents — those go to the injury slots.',
      },
      reflection: {
        type: 'string',
        description:
          "The mirror of the athlete's first goal statement (only when the turn context asks for one). Pure reflection prose in the athlete's own terms — see the reflection rules.",
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const VOICE_RULES = [
  'Voice: you are Daybreak, a sharp, warm running coach texting a friend. Real, plain, direct.',
  'Never sound like an AI. No "Great question", no "I\'d be happy to", no praising the athlete for answering.',
  'Avoid the words "genuinely", "honestly", "straightforward", "niggle". Avoid rule-of-three lists and inflated phrasing.',
  'One idea per message. Short. You can end on a question.',
].join(' ');

const NUMERIC_RULES = [
  'Numbers: never accept a bare number. A time goal is a finish time OR a pace — resolve which.',
  '"10 minute miles" is a pace; compute the implied finish for the distance. "4:25" for a marathon is hours, not minutes.',
  'Always state the unit back when you echo a time ("a 4:25 finish — four hours twenty-five").',
  'If a number is genuinely ambiguous, set numeric_unresolved and let the app offer the two readings.',
].join(' ');

const INJURY_RULES = [
  'Injuries are safety-critical. Always ask the injury beat. Mark injury_status "none" ONLY if the athlete explicitly says nothing is bothering them.',
  'Silence or a skip is NOT "no injury" — leave it unknown. Capture history (active / monitoring / past), not just today.',
].join(' ');

// Enum slots take ONLY these literal values — anything else is silently dropped,
// which strands a required slot and loops the flow. Map the athlete's words onto
// the closest literal (e.g. "a few years of consistent running" → experienced),
// never a free-text label like "intermediate".
const ENUM_RULES = [
  'Closed-enum slots take ONLY these exact literal values — never a paraphrase:',
  '- experience_tier: "beginner" (new to running), "for_fun" (runs but no structure), "some_training" (some structured training), "experienced" (years of consistent training). There is no "intermediate" — map it to some_training or experienced.',
  '- goal_distance: "5k", "10k", "half", "marathon", "keep_fit" (no race, staying fit). For ANY other stated distance — a number of miles/km, or a named distance like "50k" / "50 miler" / "44 miles" — do NOT guess a bucket; set goal_distance_mi (in miles) and leave goal_distance alone.',
  '- goal_type: "race", "general_fitness".',
  '- injury_status: "none", "active", "monitoring", "past", "unknown".',
  '- injury_detail.status: "active", "monitoring", "past".',
  'Integer-coded slots take ONLY in-range integers:',
  '- long_run_day: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday (NOT 1–7).',
  '- days_per_week: an integer between 3 and 7.',
].join('\n');

const FLOW_RULES = [
  'Fill slots from natural conversation — any message can fill any slot. Never re-ask something already answered.',
  'Work through three topics in order: 1) the goal + race, 2) current training shape (days/week, long-run day, experience), 3) injuries. One topic per message; once a topic is covered, move to the next.',
  'Some shape slots arrive already filled as "inferred, unconfirmed" from Strava. Do NOT ask those cold — state them back together in one line for a yes/no ("Looks like ~4 days/week, long runs Sunday, and you know your way around training — that right?") and let the athlete correct. A confirm flips them to confirmed.',
  'Confirm safety and plan-driving slots inline (a quick yes/no). Let nice-to-haves ride.',
  "When the goal race changes, restate goal_date in the same turn (a fill) or mark it open — never let the old race's date ride on the new goal. When a former goal race becomes a tune-up, carry its name AND its date into tune_up_races.",
  'Dates: any goal_date you emit must be in the future relative to today (the turn context states today\'s date). A bare month like "September" means its next future occurrence — pick the year accordingly.',
  'Generate the plan only once every required slot is filled and the injury beat is answered; recap the whole picture first.',
  "After the goal is settled, frame the remaining slot questions as quick logistics — scheduling details so the plan can land on a calendar — never as checking whether you understood. A form feels fine when it's labeled a form.",
  'On your very first question (conversation phase "orientation"), end the message with exactly this sentence so the athlete knows the chips are optional: "Tap a button or type an answer if it\'s not in the list." Only on that first question — never repeat it.',
].join(' ');

// The one-time reflection beat (R2, ONBOARDING_REFLECTION §2.1): before any slot
// question, the athlete's whole first goal statement gets mirrored back. The
// mirror is model-written (it must echo the athlete's words; canned copy can't)
// but rides in its own `reflection` field — the app composes it onto the turn's
// message, so it survives whatever the deterministic layer decides (a pocket
// offer, a race lookup, an override). The state summary says when one is due.
const REFLECTION_RULES = [
  'The reflection: when the turn context says the athlete has not been reflected yet AND their message carries goal content (a goal, a race, a distance, or intents), fill the `reflection` field with a short mirror of their WHOLE statement — the headline goal plus every other thread they named (qualities they want, standing concerns), in their own words, compressed. Name every thread; invent none.',
  "The reflection is pure mirror prose: no questions, no advice, no talk of what plans you can or can't build (the app handles that boundary). It reads like \"Here's what I'm hearing — …\".",
  'If the message carries only the single goal and nothing else ("I want to run CIM"), leave `reflection` empty — a mirror of one thread is padding.',
  "Never restate the athlete's goals inside `message` on that turn — the mirror lives in `reflection` only; `message` carries your next move as usual (the orientation-sentence rule still applies to `message`).",
].join(' ');

export function buildSystemPrompt(): string {
  return [
    'You are running the onboarding conversation for a marathon coaching app over Telegram.',
    VOICE_RULES,
    FLOW_RULES,
    REFLECTION_RULES,
    ENUM_RULES,
    NUMERIC_RULES,
    INJURY_RULES,
    'Each turn, call extract_and_advance with ONLY the slots that changed plus your next move. Never reply in plain text.',
  ].join('\n\n');
}

// Render the current slot state for the model: what's filled (value + provenance
// + confirmed) and what's still open, by class, plus the optional-question budget.
export function summarizeState(state: V3OnboardingState): string {
  const goalType = (state.slots.goal_type?.value as 'race' | 'general_fitness' | null) ?? null;
  const required = new Set(requiredCoreSlots(goalType));

  const lines: string[] = [];
  for (const key of SLOT_KEYS) {
    const def = SLOTS[key];
    const slot = state.slots[key];
    if (slot && slot.value != null) {
      const v =
        key === 'target_time' && typeof slot.value === 'number'
          ? formatFinishTime(slot.value)
          : JSON.stringify(slot.value);
      const conf = slot.confirmed ? 'confirmed' : 'unconfirmed';
      lines.push(`- ${key}: ${v} (${slot.provenance}, ${conf})`);
    } else {
      const tags = [def.class, required.has(key) ? 'REQUIRED-now' : null]
        .filter(Boolean)
        .join(', ');
      lines.push(`- ${key}: open [${tags}]`);
    }
  }

  const pending = state.pending_confirm;
  const pendingLine = pending
    ? `A confirm is pending for ${pending.slot} = ${JSON.stringify(pending.value)}. If the athlete affirms it ("yes", "looks right", "yep"), emit a fill for ${pending.slot} with provenance "stated" to resolve it. If they correct it, emit the corrected value.`
    : null;

  // An out-of-catalog goal is awaiting consent to the marathon-proxy. A chip tap
  // resolves it in code; this covers a typed reply. (V3-W8.)
  const ooc = state.out_of_catalog;
  const oocLine =
    ooc?.consent === 'pending'
      ? `An out-of-catalog goal is pending consent: "${ooc.words}"${ooc.distance_mi != null ? ` (~${Math.round(ooc.distance_mi)} mi)` : ''}. If the athlete accepts a ${ooc.proxy}-shaped plan toward it, emit goal_distance = "${ooc.proxy}" (provenance "stated"). If they'd rather aim at something else, emit their new goal instead.`
      : null;

  // The reflection beat is still owed (R2) — the rules tell the model what a due
  // reflection looks like; this line is the trigger.
  const reflectionLine = !hasReflected(state)
    ? 'The athlete has NOT been reflected yet: if this message carries goal content, fill `reflection` per the reflection rules.'
    : null;

  // The running intents list, so the model emits only NEW ones (the app appends,
  // dedupes, and caps in code).
  const intentsLine = state.intents?.length
    ? `Intents already captured (emit only new ones): ${state.intents.map((i) => `"${i}"`).join(', ')}.`
    : null;

  return [
    `Conversation phase: ${state.phase}. Goal type: ${goalType ?? 'unknown'}. Optional-question budget remaining: ${state.optional_budget_remaining}.`,
    pendingLine,
    oocLine,
    reflectionLine,
    intentsLine,
    'Slots:',
    lines.join('\n'),
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Caller
// ---------------------------------------------------------------------------

export interface ExtractAdvanceInput {
  state: V3OnboardingState;
  history: HistoryTurn[];
  latest: string;
  athleteId: string;
}

export interface ExtractAdvanceResult {
  output: ExtractAdvanceOutput;
  inputTokens: number;
  outputTokens: number;
}

function formatHistory(history: HistoryTurn[]): string {
  return history.map((m) => `${m.direction === 'in' ? 'Athlete' : 'Coach'}: ${m.body}`).join('\n');
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The cached Strava snapshot, for Opener 2 ("looks like you run ~4×/week…").
// The model proposes experience_tier / days_per_week / long_run_day as INFERRED
// fills the athlete then confirms — never as cold questions.
function formatSnapshot(state: V3OnboardingState): string {
  const s = state.strava_snapshot;
  if (!s || s.run_count === 0)
    return 'Strava: no recent running signal — ask, do not infer training shape.';
  const longDay =
    s.dominant_long_run_weekday != null ? WEEKDAYS[s.dominant_long_run_weekday] : 'unclear';
  return [
    'Strava snapshot (infer training shape from this, then confirm — do not ask cold):',
    `- ~${Math.round(s.recent_weekly_mileage_mi)} mi/wk recently (${s.runs_per_week.toFixed(1)} runs/wk)`,
    `- longest recent run ~${Math.round(s.longest_run_mi)} mi; long runs tend to land on ${longDay}`,
    `- suggested days/week: ${s.suggested_days_per_week}`,
  ].join('\n');
}

/**
 * Run one extract_and_advance turn. Forces the tool, Zod-validates, retries once
 * on a malformed call (race-lookup pattern). Throws if the model never returns a
 * valid tool call — the router catches and sends a soft fallback.
 */
export async function callExtractAndAdvance(
  input: ExtractAdvanceInput,
): Promise<ExtractAdvanceResult> {
  const client = anthropicClient();
  // The date rides in the per-turn user content, not the system prompt, so the
  // static prompt stays byte-identical (cacheable). Without it the model resolves
  // relative dates blind — "September or later" became 2025-09-01 (R1 fix 3).
  const tz = (input.state.slots.timezone?.value as string | null) ?? 'America/Los_Angeles';
  const userContent = [
    `Today is ${todayISOInTz(tz)}.`,
    '',
    'Current onboarding state:',
    summarizeState(input.state),
    '',
    formatSnapshot(input.state),
    '',
    input.history.length
      ? `Recent conversation (oldest first):\n${formatHistory(input.history)}`
      : '',
    '',
    `The athlete just said:\n${input.latest}`,
  ]
    .filter(Boolean)
    .join('\n');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [{ role: 'user', content: userContent }];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client.messages as any).create({
      model: ONBOARDING_MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(),
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'extract_and_advance' },
      messages,
    });

    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;

    const toolUse = (response.content as unknown[]).find(
      (b: unknown) => (b as { type?: string }).type === 'tool_use',
    ) as { input?: unknown } | undefined;

    const parsed = ExtractAdvanceSchema.safeParse(toolUse?.input);
    if (parsed.success) {
      return { output: parsed.data, inputTokens, outputTokens };
    }

    // Malformed — one corrective retry.
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: 'That tool call was malformed. Call extract_and_advance again with valid fields.',
    });
  }

  throw new Error('extract_and_advance returned no valid tool call after retry');
}

/** Best-effort cost ledger insert for one onboarding turn (kind 'onboarding'). */
export async function logOnboardingRun(
  athleteId: string,
  startedAt: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const costUsd =
    (inputTokens / 1_000_000) * COST_PER_M_INPUT + (outputTokens / 1_000_000) * COST_PER_M_OUTPUT;
  await supabaseAdmin()
    .from('agent_runs')
    .insert({
      athlete_id: athleteId,
      kind: 'onboarding',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      model: ONBOARDING_MODEL,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
    })
    .then(undefined, () => {
      /* non-fatal */
    });
}
