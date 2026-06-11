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
import {
  hasReflected,
  isV3OnboardingComplete,
  type PendingConfirm,
  type V3OnboardingState,
} from '../slots/slot-state';
import {
  SLOTS,
  SLOT_KEYS,
  requiredCoreSlots,
  type GoalDistanceValue,
  type GoalTypeValue,
  type SlotKey,
  type SlotState,
} from '../slots/schema';
import { unknownSlot, type SlotValue, type Provenance } from '../slots/provenance';
import { INJURY_CHIPS, SLOT_CHIPS } from '../slots/chips';
import { isPastISODate, todayISOInTz } from './numeric';
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

const PROVENANCE_RANK: Record<Provenance, number> = { unknown: 0, inferred: 1, stated: 2 };

/** The stronger of two provenances. Backs merge monotonicity — a re-emit of the
 *  same value can upgrade `inferred`→`stated`, never the reverse. */
function strongerProvenance(a: Provenance, b: Provenance): Provenance {
  return PROVENANCE_RANK[a] >= PROVENANCE_RANK[b] ? a : b;
}

/** Value equality for the monotonic-merge guard (also the recap bulk-confirm's
 *  "displayed unchanged" check). Primitives compare strictly; the two
 *  object-valued slots (injury_detail, tune_up_races) compare by shape.
 *  coerceFill builds injury_detail with a fixed key order, so JSON is stable. */
export function slotValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' || typeof b === 'object')
    return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** Apply the model's delta to the slot map, with the hard rules baked in:
 *  injury_status is only "none" on an explicit (stated) answer, an inferred
 *  safety/plan-driving fill lands unconfirmed, and — the 2026-06-05 confirm-loop
 *  fix — a re-emitted unchanged value is MONOTONIC: it can only strengthen the
 *  existing fill (confirm it, upgrade its provenance), never clear `confirmed` or
 *  downgrade it. Only a genuinely changed value resets the confirm. */
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

    const current = next[fill.slot];

    // Monotonic re-emit: the model re-emits unchanged slots as `inferred`, so a
    // re-emit of the value already held must never un-confirm it or downgrade its
    // provenance. Strengthen only — this is also how an affirmation resolves a
    // confirm: the model echoes the slot as `stated`, the value is unchanged, so
    // provenance upgrades inferred→stated and `confirmed` flips true.
    if (current && current.value != null && slotValuesEqual(current.value, coerced)) {
      const provenance = strongerProvenance(current.provenance, fill.provenance);
      next[fill.slot] = {
        value: current.value,
        provenance,
        confirmed: current.confirmed || !needsConfirm(fill.slot, fill.provenance),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as SlotValue<any>;
      continue;
    }

    // Changed value (or first fill) — reset the confirm per provenance.
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

  // A goal-race change invalidates the prior race's date AND its code-derived
  // distance unless the same delta re-supplies them (the 2026-06-05 stale-goal_date
  // fix, extended for the W8 distance derivation). Otherwise the looked-up date or
  // bucket of the previous race silently survives onto the new goal. The gate then
  // re-asks (both are required-core for a race) or resolveRace re-fills them. Same
  // recoverable tradeoff the date reset already accepts (a separately-stated
  // distance is rare on a race goal, and the recap is the net).
  const raceFill = fills.find((f) => f.slot === 'goal_race');
  const hasDateFill = fills.some((f) => f.slot === 'goal_date');
  const hasDistanceFill = fills.some((f) => f.slot === 'goal_distance');
  if (raceFill) {
    const newRace = coerceFill('goal_race', raceFill.value);
    const raceChanged = newRace !== undefined && newRace !== (slots.goal_race?.value ?? null);
    if (raceChanged && !hasDateFill && next.goal_date?.value != null) {
      next.goal_date = unknownSlot<string>();
    }
    if (raceChanged && !hasDistanceFill && next.goal_distance?.value != null) {
      next.goal_distance = unknownSlot<GoalDistanceValue>();
    }
  }

  return next;
}

function goalTypeOf(slots: SlotState): GoalTypeValue | null {
  return (slots.goal_type?.value as GoalTypeValue | null) ?? null;
}

// ---------------------------------------------------------------------------
// Intents (R2) — the goal portfolio beside the one plan-driving goal
// ---------------------------------------------------------------------------

/** DRAFT (ONBOARDING_REFLECTION §5 open decision #4) — flag for David's review. */
export const INTENTS_CAP = 5;

/** Append the model's new intents to the running list: trimmed, deduped
 *  case-insensitively, capped at INTENTS_CAP with newest winning. Append-only —
 *  an empty `incoming` is always the identity, which is what makes the synthetic
 *  turns (SYNTHETIC_GENERATE) provably unable to touch intents. */
export function mergeIntents(existing: string[] | undefined, incoming: string[]): string[] {
  const out = [...(existing ?? [])];
  for (const raw of incoming) {
    const v = raw.trim();
    if (!v) continue;
    if (out.some((e) => e.toLowerCase() === v.toLowerCase())) continue;
    out.push(v);
  }
  return out.slice(-INTENTS_CAP);
}

const GOAL_SLOTS: ReadonlySet<SlotKey> = new Set([
  'goal_type',
  'goal_distance',
  'goal_race',
  'goal_date',
]);

/** Whether this turn carried goal content — the reflection trigger (R2 §2). Any
 *  of: a fill on a goal slot, a stated out-of-bucket distance, a race to look up,
 *  or a new intent. Computable purely from (state, output), which is what lets
 *  the reflected flip live here instead of the router. */
function isGoalBearing(state: V3OnboardingState, output: ExtractAdvanceOutput): boolean {
  if (output.fills.some((f) => GOAL_SLOTS.has(f.slot))) return true;
  if (output.goal_distance_mi != null || output.race_lookup_query != null) return true;
  if (output.volume_goal != null) return true; // a volume-only ramble is still THE goal
  return output.intents.some((raw) => {
    const v = raw.trim();
    return !!v && !(state.intents ?? []).some((e) => e.toLowerCase() === v.toLowerCase());
  });
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function formatSlotValue(slot: SlotKey, value: unknown): string {
  if (slot === 'target_time' && typeof value === 'number') return formatFinishTime(value);
  if (slot === 'long_run_day' && typeof value === 'number') return WEEKDAYS[value] ?? String(value);
  if (slot === 'injury_detail' && value && typeof value === 'object') {
    const v = value as { body_part: string; status: string };
    return `${v.body_part} (${v.status})`;
  }
  // Dates render human-readable in confirms and recaps (R1 fix 3) — a wrong year
  // must be visible to a human, which "2025-09-01" wasn't. Non-ISO passes through.
  if (slot === 'goal_date' && typeof value === 'string' && ISO_DATE.test(value)) {
    return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }
  return String(value);
}

const YES_FIX_CHIPS: Chip[] = [
  { label: 'Looks right', value: 'yes' },
  { label: 'Fix it', value: 'let me fix that' },
];

// R2 copy reframe (DRAFT — David's voice pass): the old "Quick check —" opener
// framed the confirm as a comprehension test; the value statement alone reads as
// bookkeeping, which is what this actually is.
function buildConfirmMessage(slot: SlotKey, value: unknown): string {
  return `I've got your ${slotLabel(slot)} as ${formatSlotValue(slot, value)} — that right?`;
}

// Plain-words asks for the never-three-times backstop: once a confirm has gone
// out twice unresolved, stop echoing the value and ask the field outright, so the
// athlete's restatement arrives as a fresh `stated` fill instead of a yes/no the
// model keeps failing to land.
// R2 copy reframe (DRAFT — David's voice pass): scheduling framing, not
// comprehension-checking ("Want to be sure I have this").
const DIRECT_ASKS: Partial<Record<SlotKey, string>> = {
  days_per_week: "Let's pin this one down — how many days a week are you running?",
  long_run_day: "Let's pin this one down — which day do you do your long run?",
  goal_distance: "Let's pin this one down — what distance are you targeting?",
  experience_tier: "Let's pin this one down — how would you describe your running background?",
  target_time: "Let's pin this one down — what finish time are you aiming for?",
  goal_date: "Let's pin this one down — what date is your race?",
};

function buildDirectAskMessage(slot: SlotKey): string {
  return DIRECT_ASKS[slot] ?? `Let's pin this one down — what's your ${slotLabel(slot)}?`;
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
  const dateLabel = date != null ? formatSlotValue('goal_date', date) : undefined;

  if (race && dateLabel) return `• Race: ${race} — ${dateLabel} (${distLabel})`;
  if (dateLabel) return `• Goal: ${distLabel}, around ${dateLabel}`;
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

  // An accepted out-of-catalog goal recaps the athlete's REAL target, not the
  // marathon-proxy the plan is structured toward (V3-W8 §5.2 — the second chance
  // to catch a misread before plan-gen).
  const ooc = state.out_of_catalog;
  const goalLine =
    ooc?.consent === 'accepted'
      ? `• Goal: ${ooc.words}${ooc.distance_mi != null ? `, ${Math.round(ooc.distance_mi)} mi` : ''} (training as a ${DISTANCE_LABELS[ooc.proxy] ?? ooc.proxy} block)`
      : recapGoalLine(s);
  const lines: string[] = [goalLine];

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

  // The portfolio, not just the slots (R2): intents are never confirmed, so the
  // recap is the athlete's one chance to correct a missed or misread thread.
  if (state.intents?.length) {
    lines.push(`• Also working toward: ${state.intents.join(', ')}`);
  }

  if (typeof s.target_time?.value === 'number') {
    lines.push(`• Goal time: ${formatSlotValue('target_time', s.target_time.value)}`);
  }

  const name = s.name?.value as string | undefined;
  const intro = name ? `Here's what I've got for you, ${name}:` : "Here's what I've got:";
  return [intro, ...lines, '', 'Look right?'].join('\n');
}

/**
 * The slot/value pairs a recap displays — the snapshot recorded as `recap_shown`
 * when a recap goes out (R1 fix 2). KEEP IN SYNC with buildRecapMessage: a slot
 * belongs here exactly when the recap shows its value (goal_type rides along —
 * the goal line's framing displays it). Recorded off the resolved action, not
 * inside buildRecapMessage, so a model-authored recap (its own message, rendered
 * from the same slots) is captured too.
 */
export function recapDisplayedSlots(
  state: V3OnboardingState,
): Array<{ slot: SlotKey; value: unknown }> {
  const s = state.slots;
  const shown: Array<{ slot: SlotKey; value: unknown }> = [];
  const add = (slot: SlotKey) => {
    const v = s[slot];
    if (v && v.value != null && v.provenance !== 'unknown') shown.push({ slot, value: v.value });
  };

  add('goal_type');
  add('goal_distance'); // in the ooc-accepted case this is the displayed proxy
  const race = s.goal_race?.value;
  const date = s.goal_date?.value;
  if (state.out_of_catalog?.consent !== 'accepted') {
    if (race != null && date != null) add('goal_race');
    if (date != null) add('goal_date');
  }
  add('experience_tier');
  if (typeof s.days_per_week?.value === 'number') {
    add('days_per_week');
    add('long_run_day'); // displayed only alongside days_per_week
  }
  const detail = s.injury_detail?.value as { body_part?: string } | undefined;
  if (detail?.body_part) add('injury_detail');
  else if (s.injury_status?.value !== 'unknown') add('injury_status');
  if (typeof s.target_time?.value === 'number') add('target_time');

  return shown;
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
 *
 * `opts.todayISO` pins the clock for tests; production derives it from the
 * athlete's timezone slot.
 */
export function enforceGuardrails(
  state: V3OnboardingState,
  output: ExtractAdvanceOutput,
  opts?: { todayISO?: string },
): ResolvedTurn {
  let merged = mergeFills(state.slots, output.fills);

  // A goal_date in the past can never sit in the slot (R1 fix 3) — "September or
  // later" landed as 2025-09-01 and rode a rubber-stamped confirm into the plan.
  // Reset to unknown so the gate re-asks; the prompt rule makes this rare.
  const todayISO =
    opts?.todayISO ??
    todayISOInTz((merged.timezone?.value as string | null) ?? 'America/Los_Angeles');
  if (
    typeof merged.goal_date?.value === 'string' &&
    isPastISODate(merged.goal_date.value, todayISO)
  ) {
    merged = { ...merged, goal_date: unknownSlot<string>() };
  }

  // A pivot away from an ACCEPTED pocket clears it (the stale-pocket bug,
  // 2026-06-10 pressure-test): left in place, the pocket's distance_mi poisons
  // the new race's row at commit, its words hijack the recap's goal line, and a
  // stale North-star section gets written. Two deterministic tells: the merged
  // goal_distance holds a value that isn't the proxy, or this turn changed the
  // goal race — which catches a pivot whose bucket EQUALS the proxy (a 44-mi
  // pocket followed by a real marathon). The words demote to the intents merge
  // below, so the old goal rides as context instead of vanishing. The
  // race-lookup path clears in code (supersedePocket, router); a PENDING pocket
  // stays reconcilePocket's job.
  let outOfCatalog = state.out_of_catalog;
  let demotedWords: string[] = [];
  if (outOfCatalog?.consent === 'accepted') {
    const gd = merged.goal_distance;
    const distancePivot =
      !!gd && gd.value != null && gd.provenance !== 'unknown' && gd.value !== outOfCatalog.proxy;
    const newRace = merged.goal_race?.value ?? null;
    const racePivot = newRace != null && newRace !== (state.slots.goal_race?.value ?? null);
    if (distancePivot || racePivot) {
      demotedWords = [outOfCatalog.words];
      outOfCatalog = undefined;
    }
  }

  // Recap bulk-confirm, typed path (R1 fix 2): the last message out was a recap
  // and this turn resolves to generate — that's an affirmation of the displayed
  // picture, so every displayed slot whose value is unchanged is re-emitted as
  // `stated` through the monotonic merge (exactly how a single confirm resolves).
  // A slot this turn's fills corrected fails the unchanged check and takes the
  // normal gate path — at most one legitimate confirm, never the recapped five.
  if (state.recap_shown?.length && output.next_action === 'generate') {
    const reEmits: SlotFill[] = [];
    for (const shown of state.recap_shown) {
      const current = merged[shown.slot];
      if (current && current.value != null && slotValuesEqual(current.value, shown.value)) {
        reEmits.push({ slot: shown.slot, value: current.value, provenance: 'stated' });
      }
    }
    if (reEmits.length) merged = mergeFills(merged, reEmits);
  }

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
  // The engine owns pending_confirm: set only when a confirm goes out below,
  // cleared (left undefined) on every other resolution.
  let pendingConfirm: PendingConfirm | undefined;

  // Intents append + the one-time reflected flip (R2). The flip rides the
  // goal-bearing turn itself — even an overridden one, because the router
  // composes the model's `reflection` onto whatever message wins the turn, so
  // "flipped" always coincides with "mirror delivered".
  const intents = mergeIntents(state.intents, [...demotedWords, ...output.intents]);
  const reflected = hasReflected(state) || isGoalBearing(state, output) ? true : state.reflected;

  const working: V3OnboardingState = {
    ...state,
    slots: merged,
    asked,
    out_of_catalog: outOfCatalog,
    intents: intents.length ? intents : state.intents,
    reflected,
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
      const value = merged[pendingInferred]!.value;
      const prev = state.pending_confirm;
      const sameAsPrev =
        !!prev && prev.slot === pendingInferred && slotValuesEqual(prev.value, value);
      const attempts = sameAsPrev ? prev.attempts + 1 : 1;
      overridden = true;
      chips = [];
      if (attempts >= 3) {
        // Asked twice already and still unresolved — repeating the same yes/no is
        // never the move. Ask the field directly so a restatement lands as a
        // `stated` fill (pending_confirm stays cleared).
        action = 'ask';
        askSlot = pendingInferred;
        message = buildDirectAskMessage(pendingInferred);
      } else {
        action = 'confirm';
        message = buildConfirmMessage(pendingInferred, value);
        pendingConfirm = { slot: pendingInferred, value, attempts };
      }
    } else if (!isV3OnboardingComplete(working)) {
      if (state.recap_shown?.length) {
        // The athlete just affirmed a recap and the injury beat is the only thing
        // open (core is complete — the recap displayed it). A second recap would
        // loop "Looks right" → recap forever; ask the injury question directly.
        action = 'ask';
        askSlot = 'injury_status';
        message =
          'Before I build it — anything bothering you right now, or any past injuries I should know about?';
        chips = [];
        overridden = true;
      } else {
        // Injury beat not answered, or some other gate — recap instead of generating.
        action = 'recap';
        message = buildRecapMessage(working);
        chips = [];
        overridden = true;
      }
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
  working.pending_confirm = pendingConfirm;
  if (action === 'recap') working.phase = 'recap';

  // `recap_shown` means "the last outbound message was a recap" — set fresh on
  // every recap resolution, cleared on anything else (R1 fix 2). The strictest
  // policy: no stale snapshot can survive an intervening ask/confirm turn.
  working.recap_shown = action === 'recap' ? recapDisplayedSlots(working) : undefined;

  // Closed-option / yes-no asks always carry chips, in code (§5.4, principle 2).
  // An override that forced an ask owns its target slot; otherwise it's the
  // model's asked_slot, falling back to the first open required slot.
  const targetSlot: SlotKey | null =
    action === 'ask' ? (askSlot ?? output.asked_slot ?? firstOpenRequired(merged)) : null;
  chips = applyChipPolicy(action, targetSlot, chips);

  return { state: working, action, message, chips, overridden };
}

/** The no-op "try to generate" turn the deterministic resolvers feed back through
 *  the gates — chip-path confirm resolution, pocket acceptance, recap affirmation.
 *  The gates decide the real next move (ask / confirm / recap / generate). */
export const SYNTHETIC_GENERATE: ExtractAdvanceOutput = {
  fills: [],
  next_action: 'generate',
  message: '',
  chips: [],
  asked_slot: null,
  race_lookup_query: null,
  goal_distance_mi: null,
  contradiction: null,
  numeric_unresolved: null,
  // Empty/absent so a synthetic turn can never append an intent or count as
  // goal-bearing (mergeIntents is append-only; isGoalBearing sees nothing).
  intents: [],
  reflection: null,
  volume_goal: null,
};

/**
 * Resolve an outstanding `pending_confirm` deterministically — the chip-`yes`
 * fast path (router). The athlete tapped the affirmative against an exact value,
 * so no model call is needed: write the slot as a `stated` fill (mergeFills'
 * monotonic path confirms it and upgrades its provenance), clear the pending
 * confirm, then re-run the generate gate. The result chains — the next
 * unconfirmed inferred slot issues its own confirm (with a fresh pending_confirm),
 * an open required slot asks, and otherwise the flow proceeds to recap/generate.
 *
 * Caller guarantees `state.pending_confirm` is set.
 */
export function resolveConfirmAndAdvance(state: V3OnboardingState): ResolvedTurn {
  const pending = state.pending_confirm!;
  const slots = mergeFills(state.slots, [
    { slot: pending.slot, value: pending.value, provenance: 'stated' },
  ]);
  const cleared: V3OnboardingState = { ...state, slots, pending_confirm: undefined };
  return enforceGuardrails(cleared, SYNTHETIC_GENERATE);
}

/**
 * Resolve a "Looks right" chip tap against the recap deterministically (R1 fix 2).
 * The bulk-confirm AND the injury-loop guard both live in enforceGuardrails (the
 * `recap_shown` + generate path), so the chip and a typed affirmation share one
 * mechanism; this entry point just feeds the synthetic generate through it.
 *
 * Caller guarantees `state.recap_shown` is set.
 */
export function resolveRecapAffirmAndAdvance(state: V3OnboardingState): ResolvedTurn {
  return enforceGuardrails(state, SYNTHETIC_GENERATE);
}
