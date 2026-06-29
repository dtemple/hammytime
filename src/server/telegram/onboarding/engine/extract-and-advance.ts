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
import { ProvenanceSchema, type Provenance } from '../slots/provenance';
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
// Prompt-caching multipliers on the input rate: a cache WRITE bills at 1.25×, a
// cache READ at 0.1×. The static tools+system prefix is cached (see the
// cache_control marker on `system` below).
const COST_PER_M_CACHE_WRITE = COST_PER_M_INPUT * 1.25;
const COST_PER_M_CACHE_READ = COST_PER_M_INPUT * 0.1;

/** USD cost of one Sonnet onboarding turn, cache-aware. Exported so the prod cost
 *  ledger (logOnboardingRun) and the eval scorecard (engine/__evals__/drive.ts)
 *  share one formula and can't drift apart when rates or cache multipliers change. */
export function sonnetCostUsd(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}): number {
  return (
    (usage.inputTokens / 1_000_000) * COST_PER_M_INPUT +
    (usage.outputTokens / 1_000_000) * COST_PER_M_OUTPUT +
    ((usage.cacheCreationTokens ?? 0) / 1_000_000) * COST_PER_M_CACHE_WRITE +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * COST_PER_M_CACHE_READ
  );
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export type NextAction = 'ask' | 'confirm' | 'recap' | 'generate';

/**
 * Sonnet occasionally over-escapes line breaks inside the tool-call JSON string
 * fields — it emits `\\n`, which JSON-decodes to a literal backslash-n instead of a
 * real newline, so the athlete sees the characters "\n" in Telegram. Decode the
 * literal escapes back to real whitespace. Intermittent by nature, so this is a
 * deterministic post-process, not a prompt rule.
 */
function decodeLiteralEscapes(text: string): string {
  return text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

const SlotKeyEnum = z.enum(SLOT_KEYS as [SlotKey, ...SlotKey[]]);

/** A validated slot fill. The model's raw entries are parsed leniently
 *  (RawFillSchema) and normalized into this shape by the schema transform below.
 *  Value typing is slot-dependent (string / number-of-seconds / {body_part,status}
 *  / array) and coerced per-slot in guardrails.mergeFills. */
export interface SlotFill {
  slot: SlotKey;
  value: unknown;
  provenance: Provenance;
}

const SLOT_KEY_SET = new Set<string>(SLOT_KEYS);

// A fill as the model emits it, parsed LENIENTLY (slot is a bare string, provenance
// optional). The static enum on `slot` made one stray entry fail the WHOLE tool call
// → the retry loop burned out → the "Lost the thread" fallback. The observed stray:
// the model drops goal_distance_mi (a top-level field, NOT a slot) into `fills` on
// the off-catalog-distance path. normalizeFills (below) validates each entry, hoists
// the two misfiled numeric fields, and drops the rest — so a malformed fill never
// nukes the turn. Mirrors the lenient handling already used for intents/volume_goal.
const RawFillSchema = z.object({
  slot: z.string(),
  value: z.unknown(),
  provenance: z.string().nullish(),
});

const ChipSchema = z.object({ label: z.string(), value: z.string() });
export type Chip = z.infer<typeof ChipSchema>;

export const ExtractAdvanceSchema = z.object({
  // Parsed as unknown[] and normalized in the transform below — a single malformed
  // entry must never fail the whole tool call (see RawFillSchema).
  fills: z.array(z.unknown()).default([]),
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
  // A stated goal PACE in seconds per mile ("10 minute miles" → 600, "8:30 pace"
  // → 510). The model emits only the one-step unit conversion; the APP computes
  // the implied finish (paceToFinish), never the model — structured outputs drift
  // from their own prose arithmetic (the 26,200s-for-a-marathon bug). Mirrors the
  // goal_distance_mi precedent: model surfaces the number, code does the math.
  goal_pace_sec_per_mi: z
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
  // A periodic mileage target stated as a goal ("100 miles a month") — the app
  // owns the boundary (it can't be built into the schedule yet; ULTRA_SUPPORT §6
  // is deferred). Lenient: a junk shape parses to null, never burns the retry.
  volume_goal: z
    .object({ miles: z.number(), period: z.enum(['week', 'month']) })
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  // The goal is the athlete's OWN dated effort (a self-set long run, a friend's
  // route, an FKT attempt), not an organized race (V4-W4b). Drives event_kind on
  // the race row — cosmetic framing only, never plan-shaping. null/absent → race.
  event_kind: z
    .enum(['race', 'adventure'])
    .nullish()
    .transform((v) => v ?? null),
  })
  // Normalize `fills`: keep the valid-slot entries, hoist the two numeric extractor
  // fields the model sometimes misfiles into `fills` (goal_distance_mi /
  // goal_pace_sec_per_mi → their own top-level field, but only if not already set),
  // and drop anything else. A bad provenance falls back to "inferred" — the
  // conservative, needs-confirm value, so a misparse never silently auto-confirms a
  // safety/plan-driving slot.
  .transform((obj) => {
    const fills: SlotFill[] = [];
    let goalDistanceMi = obj.goal_distance_mi;
    let goalPaceSecPerMi = obj.goal_pace_sec_per_mi;

    for (const raw of obj.fills) {
      const parsed = RawFillSchema.safeParse(raw);
      if (!parsed.success) continue; // wholly malformed entry — drop, never throw
      const { slot, value, provenance } = parsed.data;

      if (SLOT_KEY_SET.has(slot)) {
        const prov = ProvenanceSchema.safeParse(provenance);
        fills.push({ slot: slot as SlotKey, value, provenance: prov.success ? prov.data : 'inferred' });
        continue;
      }
      // Misfiled top-level numeric field — recover the value the model meant to send.
      const n = typeof value === 'number' ? value : Number(value);
      if (slot === 'goal_distance_mi' && goalDistanceMi == null && Number.isFinite(n)) goalDistanceMi = n;
      else if (slot === 'goal_pace_sec_per_mi' && goalPaceSecPerMi == null && Number.isFinite(n))
        goalPaceSecPerMi = n;
      // any other unknown slot key: dropped
    }

    return { ...obj, fills, goal_distance_mi: goalDistanceMi, goal_pace_sec_per_mi: goalPaceSecPerMi };
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
          "ONLY the slots this latest message changed. Omit slots that did not change. Never restate the whole profile. Every entry's `slot` must be one of the profile-slot names in the enum below — goal_distance_mi, goal_pace_sec_per_mi, event_kind, intents, volume_goal and the rest are SEPARATE top-level fields, never `fills` entries. For an off-catalog distance set the top-level goal_distance_mi field, not a fill.",
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
          'The app already guarantees chips for the closed-option asks (the event opener, distance, experience level), the injury beat, and the final recap — leave this empty for all of those. Fill it yourself only for an OPEN question, and only when a chip earns its place: it saves the athlete a real decision or some typing AND its options are answers they can actually tell apart. Never offer two chips that land in the same place — that is one choice, not two. Chips must answer the exact question in your message: never option chips on a yes/no, and never a chip set for a different slot than the one you are asking. And put NO chips on anything that is not a question — a goodbye, an off-ramp farewell, or a reflection-only turn carries none.',
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
          "A concrete goal distance in MILES that isn't one of the standard buckets (5k/10k/half/marathon) — longer ('44 miles', '50k' ≈ 31, '100 miler') OR shorter ('a mile' → 1, '1500m' ≈ 0.93). Set it HERE, as this top-level field — it is NOT a slot, so never put goal_distance_mi inside `fills`. The app maps it to a bucket or handles it specially. Don't set this if you set race_lookup_query (the lookup carries the distance), and don't guess goal_distance from a number yourself.",
      },
      goal_pace_sec_per_mi: {
        type: 'number',
        description:
          'A stated goal PACE in SECONDS PER MILE — "10 minute miles" → 600, "8:30 pace" → 510, "running 9s" → 540. Emit this for a stated pace and let the app compute the finish time. Do NOT compute target_time from a pace yourself, and do NOT set both goal_pace_sec_per_mi and target_time for the same statement. A stated finish TIME ("sub-4", "around 3:55") still goes in target_time directly, not here.',
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
      volume_goal: {
        type: 'object',
        required: ['miles', 'period'],
        properties: {
          miles: { type: 'number' },
          period: { type: 'string', enum: ['week', 'month'] },
        },
        description:
          'A periodic mileage target the athlete states as a goal — "100 miles a month" → {miles: 100, period: "month"}, "20 a week" → {miles: 20, period: "week"}. Always emit it when stated; the app decides what to say about it. This is not a race distance — never put it in goal_distance or goal_distance_mi.',
      },
      event_kind: {
        type: 'string',
        enum: ['race', 'adventure'],
        description:
          'Set to "adventure" when the goal is the athlete\'s OWN dated effort — a self-set long run, a friend\'s route, an FKT attempt, "my own 20-miler in July" — rather than an organized race. Set "race" (or omit) for an organized event you\'d look up. When you set "adventure", ALSO fill goal_race with a short label in the athlete\'s words (e.g. "Rae Lakes Loop", "my July 20-miler") so it commits as a dated event, and do NOT set race_lookup_query (an adventure isn\'t in any race database).',
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
  'A pace ("10 minute miles", "8:30 pace", "running 9s") is NOT a finish time: emit goal_pace_sec_per_mi in seconds per mile (10:00 → 600, 8:30 → 510) and let the app compute the finish — never do the pace×distance math yourself. "4:25" for a marathon is hours, not minutes.',
  'A stated finish TIME ("sub-4", "around 3:55") is a target_time fill on that same turn — never leave it living in prose only, and never set both target_time and goal_pace_sec_per_mi for one statement.',
  'Always state the unit back when you echo a time ("a 4:25 finish — four hours twenty-five").',
  'If a number is genuinely ambiguous, set numeric_unresolved and let the app offer the two readings.',
].join(' ');

const INJURY_RULES = [
  'Injuries are safety-critical. Always ask the injury beat, once. Mark injury_status "none" ONLY if the athlete explicitly says nothing is bothering them.',
  'Silence, a dodge, or a non-answer is NOT "no injury" — emit no injury_status fill at all (leave the slot open). Capture history (active / monitoring / past), not just today.',
  'If the athlete declines or dodges the beat ("rather not get into it", "let\'s just move on"), accept that and move to the plan — do not push or re-ask. The slot stays open and onboarding still finishes; pressing a question they have already declined reads worse than the gap it leaves.',
].join(' ');

// Enum slots take ONLY these literal values — anything else is silently dropped,
// which strands a required slot and loops the flow. Map the athlete's words onto
// the closest literal (e.g. "a few years of consistent running" → experienced),
// never a free-text label like "intermediate".
const ENUM_RULES = [
  'Closed-enum slots take ONLY these exact literal values — never a paraphrase:',
  '- experience_tier: "beginner" (new to running), "for_fun" (runs but no structure), "some_training" (some structured training), "experienced" (years of consistent training). There is no "intermediate" — map it to some_training or experienced. Never infer this from Strava volume — it is asked directly.',
  '- goal_distance: "5k", "10k", "half", "marathon", "50k", "keep_fit" (no race, staying fit). A stated "50k" or "50 km" IS the "50k" bucket — fill goal_distance directly. For ANY other off-catalog distance — a number of miles/km, or a named distance like "50 miler" / "100k" / "44 miles" — do NOT guess a bucket; set goal_distance_mi (in miles) and leave goal_distance alone. The boundary cuts both ways: anything SHORTER than a 5K — "a mile" (goal_distance_mi: 1), "1500m" (≈ 0.93), "800m" (≈ 0.5) — is also not a bucket. Never map a stated distance to the nearest bucket in either direction.',
  '- goal_type: "race", "general_fitness".',
  '- injury_status: "none", "active", "monitoring", "past".',
  '- injury_detail.status: "active", "monitoring", "past".',
  'Integer-coded slots take ONLY in-range integers:',
  '- long_run_day: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday (NOT 1–7).',
  '- days_per_week: an integer between 3 and 7.',
].join('\n');

const FLOW_RULES = [
  'Fill slots from natural conversation — any message can fill any slot. Never re-ask something already answered.',
  "Work through four topics in this order, one per message — never two in one message: 1) the event they're training for — a race, or a personal goal with a date, 2) training shape from Strava (days/week, long-run day), 3) experience level, 4) injuries. Finish one before the next, and never reorder them — confirm training shape before you ask about experience.",
  'Days/week and long-run day arrive already filled as "inferred, unconfirmed" from Strava. Confirming them is how you read the athlete\'s recent effort — what their training has actually looked like the last few weeks — so the plan picks up from where they are now instead of starting cold. Do NOT ask those cold: state the recent shape back and let them correct it, framed as meeting them where they are rather than a quiz ("Looks like ~4 days a week lately, long run on Sunday — I want to build from where you actually are. That match?"). This turn is the days/long-run confirm and nothing else: set next_action "confirm" and leave asked_slot empty. Never set asked_slot "experience_tier" here, and never attach the four experience-level chips to it — that drops four unrelated answers under a yes/no. A confirm flips the slots. You may add one yes/no chip, or just let them type.',
  'Experience is a SEPARATE question that comes AFTER the days/long-run confirm — never folded into that confirm, never asked before it. A thin recent Strava read should never seem to contradict what the athlete tells you about their history. Ask it on its own turn, with next_action "ask" and asked_slot "experience_tier". Never infer it from Strava. Frame it as their whole running history, not the last couple weeks — e.g. "Looking across all your running, not just lately — how would you describe yourself as a runner?" The app supplies the four level chips for this question; do not invent your own, and do not attach them to any other question.',
  'Confirm safety and plan-driving slots inline (a quick yes/no). Let nice-to-haves ride.',
  "When the goal race changes, restate goal_date in the same turn (a fill) or mark it open — never let the old race's date ride on the new goal. When a former goal race becomes a tune-up, carry its name AND its date into tune_up_races.",
  'Dates: any goal_date you emit must be in the future relative to today (the turn context states today\'s date). A bare month like "September" means its next future occurrence — pick the year accordingly.',
  'The event can be an organized race OR the athlete\'s own dated effort (a self-set long run, a friend\'s route). For a personal effort, set event_kind "adventure" and fill goal_race with a short label from their words — never a race lookup. If a personal effort has only a month, ask once for a specific day; if they don\'t have one, emit the 15th of that month as a provisional date.',
  'Generate the plan only once every required slot is filled and the injury beat is answered; recap the whole picture first.',
  'When you write the recap yourself, include every captured intent and the goal time when one is set — the recap shows the whole picture, not just the slots.',
  'A periodic mileage target ("100 miles a month", "20 a week") is not a plan you can build — emit it as volume_goal and never promise the schedule will hit it; the app states the boundary. A rate is a no-event goal; never offer "general fitness" as a path. If the athlete pushes back, hold the line plainly and ask whether there is any dated effort to aim at — a race or a personal goal with a day.',
  "After the goal is settled, frame the remaining slot questions as quick logistics — scheduling details so the plan can land on a calendar — never as checking whether you understood. A form feels fine when it's labeled a form.",
  'On your very first question (conversation phase "orientation"), end the message with exactly this sentence so the athlete knows the chips are optional: "Tap a button or type an answer if it\'s not in the list." Only on that first question — never repeat it.',
  'Daybreak trains athletes for a dated event — a race, or a personal goal with a date. Never offer a "staying fit" / "general fitness" / "keep me fit" chip or present that as a coequal option: it reads as a supported path and it is not. A no-event athlete reaches the off-ramp by saying so in their own words, which you still accept — you just do not advertise it as a button. Once the athlete has made clear (after you have asked at least once) that there is no dated event even loosely — no race, and no personal goal with a day — accept it on that same turn: emit a goal_type fill of "general_fitness" (provenance "stated") and set next_action to "generate". Do not keep asking, do not collect training shape or injuries first, and do not write your own goodbye — the app takes over with the honest off-ramp message and a check-back. Setting general_fitness is how you hand a no-event athlete to that off-ramp; it is not offering general fitness as a coached path.',
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
    'You are running the onboarding conversation for a running coaching app over Telegram.',
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

  // An out-of-catalog goal is awaiting consent to its proxy (since V4-W4 only the
  // short side reaches here — the 5k proxy; beyond-50k goals off-ramp instead). A
  // chip tap resolves it in code; this covers a typed reply. (V3-W8.)
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

  // The goal is already flagged a personal adventure (V4-W4b) — keep it that way
  // unless the athlete pivots to an organized race; don't re-emit it every turn.
  const eventKindLine =
    state.event_kind === 'adventure'
      ? 'This goal is the athlete\'s own adventure (event_kind "adventure"), not an organized race. Keep it that way unless they switch to a named race.'
      : null;

  return [
    `Conversation phase: ${state.phase}. Goal type: ${goalType ?? 'unknown'}. Optional-question budget remaining: ${state.optional_budget_remaining}.`,
    pendingLine,
    oocLine,
    reflectionLine,
    intentsLine,
    eventKindLine,
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
  // Uncached prompt + content input tokens (the API reports the cached prefix
  // separately in the two cache fields below, NOT inside input_tokens).
  inputTokens: number;
  outputTokens: number;
  // Cache write: the turn that paid 1.25× to lay down the static prefix.
  cacheCreationTokens: number;
  // Cache read: a turn inside the 5-min TTL that read the prefix at 0.1×.
  cacheReadTokens: number;
}

function formatHistory(history: HistoryTurn[]): string {
  return history.map((m) => `${m.direction === 'in' ? 'Athlete' : 'Coach'}: ${m.body}`).join('\n');
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The cached Strava snapshot, for the training-shape confirm ("looks like you run
// ~4×/week…"). The model proposes days_per_week / long_run_day as INFERRED fills
// the athlete then confirms — never cold. Experience is NOT inferred from Strava
// (a weak proxy); it's asked directly.
function formatSnapshot(state: V3OnboardingState): string {
  const s = state.strava_snapshot;
  if (!s || s.run_count === 0)
    return 'Strava: no recent running signal — ask, do not infer training shape.';
  const longDay =
    s.dominant_long_run_weekday != null ? WEEKDAYS[s.dominant_long_run_weekday] : 'unclear';
  return [
    'Strava snapshot — infer days/week + long-run day from this, then confirm (do not ask those cold). Do NOT infer experience from it; ask experience directly.',
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
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client.messages as any).create({
      model: ONBOARDING_MODEL,
      max_tokens: MAX_TOKENS,
      // One cache breakpoint on `system` caches the whole static prefix — tools
      // precede system in cache order, so they ride along. The prefix is
      // byte-identical per call by design (the date lives in user content), so
      // back-to-back turns inside the 5-min TTL read it at 0.1×.
      system: [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'extract_and_advance' },
      messages,
    });

    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;
    cacheCreationTokens += response.usage?.cache_creation_input_tokens ?? 0;
    cacheReadTokens += response.usage?.cache_read_input_tokens ?? 0;

    const toolUse = (response.content as unknown[]).find(
      (b: unknown) => (b as { type?: string }).type === 'tool_use',
    ) as { input?: unknown } | undefined;

    const parsed = ExtractAdvanceSchema.safeParse(toolUse?.input);
    if (parsed.success) {
      const output = {
        ...parsed.data,
        message: decodeLiteralEscapes(parsed.data.message),
        reflection: parsed.data.reflection
          ? decodeLiteralEscapes(parsed.data.reflection)
          : parsed.data.reflection,
      };
      return { output, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens };
    }

    // The fills-resilience above (RawFillSchema + the normalize transform) absorbs
    // the common stray-fill malformation (a misfiled goal_distance_mi), so reaching
    // here now means a structural miss (no/blank message or next_action) or no tool
    // call at all (a transient). Log the cause — the only window, since the eventual
    // throw records no usage/output downstream (this is what the fallback hides).
    console.error(
      `[onboarding] extract_and_advance malformed (attempt ${attempt}): ` +
        `stop_reason=${response.stop_reason}, tool_use=${toolUse != null}, ` +
        `issues=${JSON.stringify(parsed.error.issues).slice(0, 400)}`,
    );

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
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
): Promise<void> {
  const costUsd = sonnetCostUsd({ inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens });
  await supabaseAdmin()
    .from('agent_runs')
    .insert({
      athlete_id: athleteId,
      kind: 'onboarding',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      model: ONBOARDING_MODEL,
      // input_tokens records total prompt volume (uncached + both cache classes)
      // so the ledger's token count still reflects the real prompt size.
      input_tokens: inputTokens + cacheCreationTokens + cacheReadTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
    })
    .then(undefined, () => {
      /* non-fatal */
    });
}
