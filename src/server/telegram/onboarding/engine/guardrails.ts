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
import { INJURY_CHIPS, SLOT_CHIPS } from '../slots/chips';
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
    case 'target_time': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? Math.round(n) : undefined;
    }
    // Range-checked against the athlete_training_profile CHECK constraints
    // (20260601000000_athlete_training_profile.sql): an out-of-range integer
    // survives rounding but blows up the commit upsert, stranding onboarding on
    // "Hit a snag saving your profile". Drop it so the gate re-asks instead.
    case 'days_per_week': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return undefined;
      const r = Math.round(n);
      return r >= 3 && r <= 7 ? r : undefined;
    }
    case 'long_run_day': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return undefined;
      const r = Math.round(n);
      return r >= 0 && r <= 6 ? r : undefined;
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
    if (coerced === undefined) {
      // Dropped invalid. Silent drops on a required slot strand the flow (the
      // §5 experience_tier loop), so make them visible.
      if (SLOTS[fill.slot].class === 'required-core') {
        console.warn(
          `[onboarding] dropped invalid ${fill.slot} fill: ${JSON.stringify(fill.value)}`,
        );
      }
      continue;
    }

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
  return `One more thing before I build your plan — what's your ${slotLabel(slot)}?`;
}

const DISTANCE_LABELS: Record<string, string> = {
  '5k': '5K',
  '10k': '10K',
  half: 'half marathon',
  marathon: 'marathon',
  keep_fit: 'general fitness',
};

const TIER_LABELS: Record<string, string> = {
  beginner: 'beginner',
  for_fun: 'running for fun',
  some_training: 'some structured training',
  experienced: 'experienced',
};

/** The goal line: a committed race (name + date), an intended distance with a
 *  rough timeframe, a no-race base, or just the distance. */
function recapGoalLine(s: SlotState): string {
  const distance = s.goal_distance?.value as string | undefined;
  if (distance === 'keep_fit') return '• Goal: staying fit, no race on the calendar';

  const distLabel = distance ? (DISTANCE_LABELS[distance] ?? distance) : 'race';
  const race = s.goal_race?.value as string | undefined;
  const date = s.goal_date?.value as string | undefined;

  if (race && date) return `• Race: ${race} — ${date} (${distLabel})`;
  if (date) return `• Goal: ${distLabel}, around ${date}`;
  return `• Goal: ${distLabel}`;
}

/** The injury line, from the described detail if there is one, else the status. */
function recapInjuryLine(s: SlotState): string | null {
  const detail = s.injury_detail?.value as { body_part: string; status: string } | undefined;
  if (detail?.body_part) return `• Injuries: ${detail.body_part} (${detail.status})`;
  const status = s.injury_status?.value as string | undefined;
  if (status === 'none') return '• Injuries: nothing bothering you';
  if (status === 'unknown' || status == null) return null;
  return `• Injuries: ${status}`;
}

export function buildRecapMessage(state: V3OnboardingState): string {
  const s = state.slots;

  const lines: string[] = [recapGoalLine(s)];

  const tier = s.experience_tier?.value as string | undefined;
  if (tier) lines.push(`• Experience: ${TIER_LABELS[tier] ?? tier}`);

  const days = s.days_per_week?.value;
  const longDay = s.long_run_day?.value;
  if (typeof days === 'number') {
    const lr = typeof longDay === 'number' ? `, long run ${WEEKDAYS[longDay]}` : '';
    lines.push(`• ${days} days a week${lr}`);
  }

  const injury = recapInjuryLine(s);
  if (injury) lines.push(injury);

  if (typeof s.target_time?.value === 'number') {
    lines.push(`• Goal time: ${formatSlotValue('target_time', s.target_time.value)}`);
  }

  const name = s.name?.value as string | undefined;
  const intro = name ? `Here's what I've got for you, ${name}:` : "Here's what I've got:";
  return [intro, ...lines, '', 'Look right?'].join('\n');
}

// ---------------------------------------------------------------------------
// Chip policy (V3-W4, §5.4 + principle 2)
// ---------------------------------------------------------------------------

/**
 * Guarantee chips for closed-option and yes/no turns in code, rather than
 * trusting the model to attach them. The model still proposes chips for open
 * questions where it wants to offer a shortcut; those pass through untouched.
 *  - ask + injury beat                       → INJURY_CHIPS (the gate's set)
 *  - ask + a slot with a canonical set       → that set (overrides the model)
 *  - confirm | recap with no chips           → YES_FIX_CHIPS (a yes/no is owed one)
 *  - anything else (open ask, model's chips) → modelChips unchanged
 */
export function applyChipPolicy(
  action: NextAction,
  targetSlot: SlotKey | null,
  modelChips: Chip[],
): Chip[] {
  if (action === 'ask' && targetSlot) {
    if (targetSlot === 'injury_status') return [...INJURY_CHIPS];
    const canonical = SLOT_CHIPS[targetSlot];
    if (canonical) return [...canonical];
  }
  if ((action === 'confirm' || action === 'recap') && modelChips.length === 0) {
    return [...YES_FIX_CHIPS];
  }
  return modelChips;
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
  // When an override forces an ask, it owns the target slot — the model's
  // asked_slot may be stale. Otherwise the chip policy derives it (below).
  let askSlot: SlotKey | null = null;

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
      askSlot = openRequired;
      message = buildAskMessage(openRequired);
      chips = [];
      overridden = true;
    } else if (pendingInferred) {
      action = 'confirm';
      message = buildConfirmMessage(pendingInferred, merged[pendingInferred]!.value);
      chips = [];
      overridden = true;
    } else if (!isV3OnboardingComplete(working)) {
      // Injury beat not answered, or some other gate — recap instead of generating.
      action = 'recap';
      message = buildRecapMessage(working);
      chips = [];
      overridden = true;
    }
  }

  // --- optional-budget gate ---
  if (action === 'ask' && output.asked_slot && isOptionalClass(output.asked_slot)) {
    if (budget <= 0) {
      // Out of optional questions — move to the recap rather than ask more.
      action = 'recap';
      message = buildRecapMessage(working);
      chips = [];
      overridden = true;
    } else {
      budget -= 1;
    }
  }

  working.optional_budget_remaining = budget;
  if (action === 'recap') working.phase = 'recap';

  // Closed-option / yes-no asks always carry chips, in code (§5.4, principle 2).
  // An override that forced an ask owns its target slot; otherwise it's the
  // model's asked_slot, falling back to the first open required slot.
  const targetSlot: SlotKey | null =
    action === 'ask' ? (askSlot ?? output.asked_slot ?? firstOpenRequired(merged)) : null;
  chips = applyChipPolicy(action, targetSlot, chips);

  return { state: working, action, message, chips, overridden };
}
