// Onboarding v3 (V3-W2): the code guardrails (ONBOARDING_V3 §5.4).
//
// The model proposes a turn (extract_and_advance); these pure functions dispose.
// Every safety invariant is enforced here in TypeScript, never left to the
// prompt: the injury beat can't be faked, an inferred plan-driving value can't
// reach plan-gen unconfirmed, generate can't fire with a required slot open, and
// the optional-question budget is a hard counter the engine owns — not a number
// the model is trusted to respect. When a guardrail overrides the model's
// next_action it substitutes a deterministic message (W3 refines the copy); on
// the happy path the model's message and chips pass straight through.

import { formatFinishTime } from '../parsing/durations';
import { isV3OnboardingComplete, type V3OnboardingState } from '../slots/slot-state';
import {
  SLOTS,
  SLOT_KEYS,
  requiredCoreSlots,
  type GoalTypeValue,
  type SlotKey,
  type SlotState,
} from '../slots/schema';
import type { SlotValue, Provenance } from '../slots/provenance';
import type { Chip, ExtractAdvanceOutput, NextAction, SlotFill } from './extract-and-advance';

const EXPERIENCE = new Set(['beginner', 'for_fun', 'some_training', 'experienced']);
const DISTANCE = new Set(['5k', '10k', 'half', 'marathon', 'keep_fit']);
const GOAL_TYPE = new Set(['race', 'general_fitness']);
const INJURY_STATUS = new Set(['none', 'active', 'monitoring', 'past', 'unknown']);
const INJURY_DETAIL_STATUS = new Set(['active', 'monitoring', 'past']);

/** Per-slot validation/coercion of a raw model value. Returns undefined to drop
 *  an invalid fill (e.g. an experience tier outside the enum) rather than write junk. */
export function coerceFill(slot: SlotKey, value: unknown): unknown {
  if (value == null) return null;
  switch (slot) {
    case 'goal_type':
      return GOAL_TYPE.has(String(value)) ? value : undefined;
    case 'goal_distance':
      return DISTANCE.has(String(value)) ? value : undefined;
    case 'experience_tier':
      return EXPERIENCE.has(String(value)) ? value : undefined;
    case 'injury_status':
      return INJURY_STATUS.has(String(value)) ? value : undefined;
    case 'age':
    case 'target_time':
    case 'days_per_week':
    case 'long_run_day': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? Math.round(n) : undefined;
    }
    case 'injury_detail': {
      const v = value as { body_part?: unknown; status?: unknown };
      if (!v || typeof v !== 'object') return undefined;
      if (!v.body_part || !INJURY_DETAIL_STATUS.has(String(v.status))) return undefined;
      return { body_part: String(v.body_part), status: v.status };
    }
    case 'tune_up_races':
      return Array.isArray(value) ? value : undefined;
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/** Whether a slot fill must clear an explicit confirm turn before it's usable.
 *  Only INFERRED safety/plan-driving values do (§5.4) — a stated value is taken
 *  at face (the recap is the final catch). */
function needsConfirm(slot: SlotKey, provenance: Provenance): boolean {
  const def = SLOTS[slot];
  return (def.planDriving || def.safety) && provenance !== 'stated';
}

/** Apply the model's delta to the slot map, with two hard rules baked in:
 *  injury_status is only "none" on an explicit (stated) answer, and an inferred
 *  safety/plan-driving fill lands unconfirmed. */
export function mergeFills(slots: SlotState, fills: SlotFill[]): SlotState {
  const next: SlotState = { ...slots };
  for (const fill of fills) {
    const coerced = coerceFill(fill.slot, fill.value);
    if (coerced === undefined) continue; // dropped invalid

    let value = coerced;
    let provenance = fill.provenance;

    // Injury never becomes "none" by inference — silence/inference stays unknown.
    if (fill.slot === 'injury_status' && value === 'none' && provenance !== 'stated') {
      value = 'unknown';
      provenance = 'unknown';
    }

    next[fill.slot] = {
      value,
      provenance,
      confirmed: !needsConfirm(fill.slot, provenance),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as SlotValue<any>;
  }
  return next;
}

function goalTypeOf(slots: SlotState): GoalTypeValue | null {
  return (slots.goal_type?.value as GoalTypeValue | null) ?? null;
}

/** The first required-core slot still open, or null. */
export function firstOpenRequired(slots: SlotState): SlotKey | null {
  for (const key of requiredCoreSlots(goalTypeOf(slots))) {
    const slot = slots[key];
    if (!slot || slot.value == null || slot.provenance === 'unknown') return key;
  }
  return null;
}

/** The first safety/plan-driving slot holding an unconfirmed inferred value — the
 *  §5.4 block on reaching plan-gen with an un-vetted inference. */
export function firstUnconfirmedInferred(slots: SlotState): SlotKey | null {
  for (const key of SLOT_KEYS) {
    const def = SLOTS[key];
    if (!def.planDriving && !def.safety) continue;
    const slot = slots[key];
    if (slot && slot.value != null && slot.provenance === 'inferred' && !slot.confirmed) return key;
  }
  return null;
}

function isOptionalClass(slot: SlotKey): boolean {
  const c = SLOTS[slot].class;
  return c === 'optional' || c === 'optional-deferred';
}

// ---------------------------------------------------------------------------
// Deterministic fallback copy (override paths only; W3 refines)
// ---------------------------------------------------------------------------

const LABELS: Partial<Record<SlotKey, string>> = {
  goal_type: 'goal',
  experience_tier: 'experience',
  goal_distance: 'distance',
  goal_race: 'race',
  goal_date: 'race date',
  days_per_week: 'days per week',
  long_run_day: 'long-run day',
  injury_status: 'injuries',
  target_time: 'goal time',
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function slotLabel(slot: SlotKey): string {
  return LABELS[slot] ?? slot.replace(/_/g, ' ');
}

export function formatSlotValue(slot: SlotKey, value: unknown): string {
  if (slot === 'target_time' && typeof value === 'number') return formatFinishTime(value);
  if (slot === 'long_run_day' && typeof value === 'number') return WEEKDAYS[value] ?? String(value);
  if (slot === 'injury_detail' && value && typeof value === 'object') {
    const v = value as { body_part: string; status: string };
    return `${v.body_part} (${v.status})`;
  }
  return String(value);
}

const YES_FIX_CHIPS: Chip[] = [
  { label: 'Looks right', value: 'yes' },
  { label: 'Fix it', value: 'let me fix that' },
];

function buildConfirmMessage(slot: SlotKey, value: unknown): string {
  return `Quick check — I've got your ${slotLabel(slot)} as ${formatSlotValue(slot, value)}. Right?`;
}

function buildAskMessage(slot: SlotKey): string {
  return `Before I build your plan I still need your ${slotLabel(slot)}.`;
}

export function buildRecapMessage(state: V3OnboardingState): string {
  const s = state.slots;
  const line = (slot: SlotKey) => {
    const v = s[slot];
    return v && v.value != null ? `• ${slotLabel(slot)}: ${formatSlotValue(slot, v.value)}` : null;
  };
  const order: SlotKey[] = [
    'goal_distance',
    'goal_race',
    'goal_date',
    'experience_tier',
    'days_per_week',
    'long_run_day',
    'injury_status',
    'target_time',
  ];
  const bits = order.map(line).filter(Boolean);
  return ["Here's what I've got:", ...bits, '', 'Look right?'].join('\n');
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export interface ResolvedTurn {
  state: V3OnboardingState;
  action: NextAction;
  message: string;
  chips: Chip[];
  /** True when a guardrail overrode the model's proposed action. */
  overridden: boolean;
}

/**
 * Merge the model's delta and resolve the turn against the §5.4 invariants.
 * Override priority: generate→(open required ⇒ ask) / (unconfirmed inference ⇒
 * confirm); optional ask over budget ⇒ recap; otherwise the model's move stands.
 */
export function enforceGuardrails(
  state: V3OnboardingState,
  output: ExtractAdvanceOutput,
): ResolvedTurn {
  const merged = mergeFills(state.slots, output.fills);

  const asked = [...state.asked];
  if (output.asked_slot && !asked.includes(output.asked_slot)) asked.push(output.asked_slot);

  let budget = state.optional_budget_remaining;
  let action: NextAction = output.next_action;
  let message = output.message;
  let chips = output.chips;
  let overridden = false;

  const working: V3OnboardingState = {
    ...state,
    slots: merged,
    asked,
    optional_budget_remaining: budget,
    phase: state.phase === 'orientation' ? 'intake' : state.phase,
  };

  // --- generate gate ---
  if (action === 'generate') {
    const openRequired = firstOpenRequired(merged);
    const pendingInferred = firstUnconfirmedInferred(merged);
    if (openRequired) {
      action = 'ask';
      message = buildAskMessage(openRequired);
      chips = [];
      overridden = true;
    } else if (pendingInferred) {
      action = 'confirm';
      message = buildConfirmMessage(pendingInferred, merged[pendingInferred]!.value);
      chips = YES_FIX_CHIPS;
      overridden = true;
    } else if (!isV3OnboardingComplete(working)) {
      // Injury beat not answered, or some other gate — recap instead of generating.
      action = 'recap';
      message = buildRecapMessage(working);
      chips = YES_FIX_CHIPS;
      overridden = true;
    }
  }

  // --- optional-budget gate ---
  if (action === 'ask' && output.asked_slot && isOptionalClass(output.asked_slot)) {
    if (budget <= 0) {
      // Out of optional questions — move to the recap rather than ask more.
      action = 'recap';
      message = buildRecapMessage(working);
      chips = YES_FIX_CHIPS;
      overridden = true;
    } else {
      budget -= 1;
    }
  }

  working.optional_budget_remaining = budget;
  if (action === 'recap') working.phase = 'recap';

  return { state: working, action, message, chips, overridden };
}
