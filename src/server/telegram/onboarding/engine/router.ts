// Onboarding v3 (V3-W2): the per-turn router — the orchestrator.
//
// On each inbound onboarding message (or chip tap) it: dedups Telegram retries,
// logs the inbound, runs the extract_and_advance turn under a typing indicator,
// applies the §5.4 guardrails, runs the deterministic numeric backstop (§5.1) and
// the race lookup, then sends the next message + chips — or, on generate, commits
// the slots, builds the plan, and shows the preview.
//
// The model proposes; the code disposes. Every safety decision lives in
// guardrails.ts / numeric.ts / commit.ts (all pure + tested); this file is the
// wiring that runs them in order and talks to Telegram.

import { InlineKeyboard, type Context } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import type { Database } from '@/lib/db-types';
import { sendDavidAlert } from '@/server/admin/alerts';
import { botApiForChat } from '../../bot';
import { selectionKeyboardFromTap, labelForTap } from '../dispatcher';
import { lookupRace } from '@/server/agent/race-lookup';
import { enterDormant, exitDormant, setCheckBack } from '../../pause';
import { KNOWN_GAPS, type KnownGapKey } from '@/lib/known-gaps';
import {
  hasReflected,
  loadV3State,
  saveV3State,
  type V3OnboardingState,
} from '../slots/slot-state';
import { slotsToGaps, type GoalDistanceValue, type SlotState } from '../slots/schema';
import { slotValue } from '../slots/provenance';
import {
  loadKnownGapsContent,
  parseKnownGaps,
  seedKnownGapsFromFilled,
} from '../known-gaps-memory';
import { callExtractAndAdvance, logOnboardingRun, type Chip } from './extract-and-advance';
import {
  enforceGuardrails,
  mergeFills,
  resolveConfirmAndAdvance,
  resolveRecapAffirmAndAdvance,
} from './guardrails';
import { loadRecentHistory } from './history';
import {
  CATALOG_FLOOR_MI,
  deriveBucketFromMiles,
  isPastISODate,
  resolveFinishTime,
  resolveFinishTimeForMiles,
  todayISOInTz,
} from './numeric';
import {
  acceptPocketAndAdvance,
  applyStatedDistance,
  applyVolumeGoal,
  declinePocket,
  formatShortTarget,
  pocketBody,
  POCKET_CHIPS,
  REFLECTION_POCKET_CHIPS,
  reconcilePocket,
  setPocket,
  supersedePocket,
  volumeBoundaryBody,
  VOLUME_REDIRECT_CHIPS,
} from './pocket';
import { withTyping } from './typing';

type AthleteRow = Database['public']['Tables']['athletes']['Row'];

const CHIP_PREFIX = 'v3:';

// ---------------------------------------------------------------------------
// Entry off-ramp (Onboarding v4 / V4-W2) — copy + helpers
// ---------------------------------------------------------------------------
//
// A no-event signup is NOT given a keep_fit plan (v4 retires that). Instead, when
// onboarding would generate for a general_fitness athlete, the off-ramp fires in
// two beats inside finishOnboarding: first the honest "here's what I'm for, anything
// on your radar?" (a named goal here re-opens the normal flow), then — if they come
// back still event-less — an acknowledgement + a check-back capture. The athlete is
// dormant throughout (no plan, daily cron skips them). All copy here is DRAFT for
// David's voice pass (§8, Decision 7); the load-bearing phrase to preserve is
// "a race, or a personal goal with a date."

const OFF_RAMP_OFFER = [
  "I'll be straight with you: Daybreak is built around training for something — a race, " +
    'or a personal goal with a date and a distance. A friend’s 30-mile birthday run counts. ' +
    '"Get faster this year" doesn’t quite, because there’s no day for me to build toward.',
  'What I do is ramp your training and taper it so you show up ready on the day. No day, ' +
    "and I’m just sending easy runs you don’t need an app for.",
  'Anything on your radar, even loosely? A distance you’ve been eyeing, a trip with some ' +
    "long days in it? Tell me and we’ll start there. If not, all good.",
].join('\n\n');

const ACK_NO_GOAL =
  "No worries — I’ll leave it there. Daybreak only really works once there’s a plan to " +
  'keep you on track, and a plan needs a day to build toward. Want me to check back when ' +
  'something might be on the calendar?';

const CHECK_BACK_DECLINED =
  "All good — I’ll leave it here. Whenever something lands on the calendar, message me and " +
  "I’ll build you a plan for it.";

const CHECK_BACK_CHIPS: Chip[] = [
  { label: 'In a month', value: 'checkback:1m' },
  { label: 'In 3 months', value: 'checkback:3m' },
  { label: 'In 6 months', value: 'checkback:6m' },
  { label: "Don't bother", value: 'checkback:none' },
];

/** Months out for each check-back chip value; absent (e.g. 'checkback:none') = clear. */
const CHECK_BACK_MONTHS: Record<string, number> = {
  'checkback:1m': 1,
  'checkback:3m': 3,
  'checkback:6m': 6,
};

/** A no-event goal: general_fitness, the one shape v4 off-ramps (a rate / "stay
 *  fit" with no single dated effort). Race + intended both stay first-class. */
function isNoEventGoal(state: V3OnboardingState): boolean {
  return state.slots.goal_type?.value === 'general_fitness';
}

/** ISO timestamp `months` out from now — the one-shot check-back nudge date. */
function checkBackDateISO(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

function checkBackConfirm(months: number): string {
  const when = months === 1 ? 'in a month' : `in ${months} months`;
  return `Done — I’ll check back ${when}. If anything lands on the calendar before then, just tell me and we’re off.`;
}

// ---------------------------------------------------------------------------
// Telegram I/O
// ---------------------------------------------------------------------------

async function logInbound(athleteId: string, body: string): Promise<void> {
  await supabaseAdmin()
    .from('messages')
    .insert({ athlete_id: athleteId, channel: 'tg', direction: 'in', body });
}

async function sendV3(
  athleteId: string,
  chatId: number | string,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  await botApiForChat(chatId).sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : {});
  await supabaseAdmin()
    .from('messages')
    .insert({ athlete_id: athleteId, channel: 'tg', direction: 'out', body: text });
}

/** One chip per row (never truncate labels — see the onboarding button memo). The
 *  chip's value rides in the callback data; the tap is replayed as that value. */
function chipsKeyboard(chips: Chip[]): InlineKeyboard | undefined {
  if (!chips.length) return undefined;
  const kb = new InlineKeyboard();
  for (const c of chips) kb.text(c.label, `${CHIP_PREFIX}${c.value.slice(0, 60)}`).row();
  return kb;
}

function nextActionsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Add to calendar', 'next:calendar')
    .row()
    .text('Adjust the plan', 'next:adjust')
    .row()
    .text("That's it for today", 'next:done');
}

const mkSlot = slotValue;

/**
 * Prefix the model's one-time mirror onto whatever message won the turn (R2).
 * Composition happens at the single send point, AFTER the override / race-lookup
 * / pocket / backstop logic has settled `message` — that's what lets the mirror
 * survive every turn shape instead of dying with the model's discarded message.
 * `boundaryLead` is set when the message is the bare stated-distance pocket offer:
 * with a mirror in front, the offer reads as a turn ("One thing to be straight
 * about: a mile race is shorter than…") instead of a cold open.
 */
function composeReflection(
  reflection: string | null,
  message: string,
  boundaryLead: boolean,
): string {
  const mirror = reflection?.trim();
  if (!mirror) return message;
  const body = boundaryLead
    ? `One thing to be straight about: ${message.charAt(0).toLowerCase()}${message.slice(1)}`
    : message;
  return `${mirror}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

interface TurnInput {
  athlete: AthleteRow;
  chatId: number | string;
  /** What the model sees as the athlete's message (a chip's value, or typed text). */
  text: string;
  /** Dedup key: `m:<message_id>` or `c:<callback_id>`. */
  dedupKey?: string;
  /** What to log as the inbound (the chip's human label, or the typed text). */
  logBody?: string;
  /** True when `text` is a chip's value (an exact, code-controlled token), not
   *  typed prose. Only a chip tap can resolve a pending confirm in code. */
  fromChip?: boolean;
}

async function runTurn({
  athlete,
  chatId,
  text,
  dedupKey,
  logBody,
  fromChip,
}: TurnInput): Promise<void> {
  const athleteId = athlete.id;
  const state = await loadV3State(athleteId);
  if (!state) return; // not a v3 athlete (gated upstream)

  // /edit_profile "Finish my profile" walk owns the turn while active (W3).
  if (state.edit_mode?.kind === 'finish_gaps') {
    await runGapWalkTurn({ athlete, chatId, text, dedupKey, logBody }, state);
    return;
  }

  if (dedupKey && state.last_processed_key === dedupKey) return; // Telegram retry

  // Off-ramp check-back chip (v4 / V4-W2): a dormant no-event athlete picked a
  // check-back interval (or "Don't bother"). Resolved in code — set the one-shot
  // nudge date and confirm; no model call. Only ever sent at phase 'off_ramp'.
  if (fromChip && text.startsWith('checkback:')) {
    await logInbound(athleteId, logBody ?? text);
    const n = CHECK_BACK_MONTHS[text];
    if (n != null) {
      await setCheckBack(athleteId, checkBackDateISO(n));
      await sendV3(athleteId, chatId, checkBackConfirm(n));
    } else {
      await setCheckBack(athleteId, null);
      await sendV3(athleteId, chatId, CHECK_BACK_DECLINED);
    }
    await saveV3State(athleteId, {
      ...state,
      last_processed_key: dedupKey ?? state.last_processed_key,
    });
    return;
  }

  // Pending-confirm fast path (the 2026-06-05 confirm-loop fix): a `yes` chip tap
  // against an outstanding guardrail confirm resolves it in code — the value is
  // exact, so there's nothing for the model to interpret. Typed "looks right" and
  // "Fix it" fall through to the model (summarizeState names the pending confirm).
  if (state.pending_confirm && fromChip && text === 'yes') {
    await logInbound(athleteId, logBody ?? text);
    await withTyping(chatId, async () => {
      const resolved = resolveConfirmAndAdvance(state);
      const working: V3OnboardingState = {
        ...resolved.state,
        last_processed_key: dedupKey ?? state.last_processed_key,
      };
      if (resolved.action === 'generate') {
        await finishOnboarding(athlete, chatId, working);
        return;
      }
      await saveV3State(athleteId, working);
      await sendV3(athleteId, chatId, resolved.message, chipsKeyboard(resolved.chips));
    });
    return;
  }

  // Pocket consent fast path (V3-W8): a chip tap against an outstanding
  // out-of-catalog offer resolves in code — `yes` takes the marathon-proxy and
  // advances; `no` re-offers. Typed replies fall through to the model (the pocket
  // is surfaced in summarizeState; reconcilePocket settles the result below).
  if (
    state.out_of_catalog?.consent === 'pending' &&
    fromChip &&
    (text === 'yes' || text === 'no')
  ) {
    await logInbound(athleteId, logBody ?? text);
    await withTyping(chatId, async () => {
      if (text === 'no') {
        const declined = declinePocket(state);
        await saveV3State(athleteId, {
          ...declined.state,
          last_processed_key: dedupKey ?? state.last_processed_key,
        });
        await sendV3(athleteId, chatId, declined.message, chipsKeyboard(declined.chips));
        return;
      }
      const resolved = acceptPocketAndAdvance(state);
      const working: V3OnboardingState = {
        ...resolved.state,
        last_processed_key: dedupKey ?? state.last_processed_key,
      };
      if (resolved.action === 'generate') {
        await finishOnboarding(athlete, chatId, working);
        return;
      }
      await saveV3State(athleteId, working);
      await sendV3(athleteId, chatId, resolved.message, chipsKeyboard(resolved.chips));
    });
    return;
  }

  // Recap-affirm fast path (R1 fix 2): "Looks right" against the recap confirms
  // every displayed slot in code — the athlete just affirmed the whole picture, so
  // walking per-slot "Quick check" turns afterward is redundant (the Nathan
  // transcript's five serial confirms). Typed affirmations fall through to the
  // model; the same bulk-confirm fires in enforceGuardrails when its turn resolves
  // to generate.
  if (
    state.recap_shown?.length &&
    fromChip &&
    text === 'yes' &&
    !state.pending_confirm &&
    state.out_of_catalog?.consent !== 'pending'
  ) {
    await logInbound(athleteId, logBody ?? text);
    await withTyping(chatId, async () => {
      const resolved = resolveRecapAffirmAndAdvance(state);
      const working: V3OnboardingState = {
        ...resolved.state,
        last_processed_key: dedupKey ?? state.last_processed_key,
      };
      if (resolved.action === 'generate') {
        await finishOnboarding(athlete, chatId, working);
        return;
      }
      await saveV3State(athleteId, working);
      await sendV3(athleteId, chatId, resolved.message, chipsKeyboard(resolved.chips));
    });
    return;
  }

  await logInbound(athleteId, logBody ?? text);

  await withTyping(chatId, async () => {
    const history = await loadRecentHistory(athleteId, 12);
    const startedAt = new Date().toISOString();

    // One retry on a failed model call (R1 fix 6): the Nathan transcript hit this
    // fallback mid-onboarding on a transient API error. The athlete is waiting
    // inside the typing indicator, so one immediate retry, no backoff, no third.
    let result;
    try {
      result = await callExtractAndAdvance({ state, history, latest: text, athleteId });
    } catch (firstErr) {
      console.error('[v3] extract_and_advance failed, retrying', firstErr);
      try {
        result = await callExtractAndAdvance({ state, history, latest: text, athleteId });
      } catch (err) {
        console.error('[v3] extract_and_advance failed', err);
        await sendV3(
          athleteId,
          chatId,
          'Lost the thread there for a second — mind saying that again?',
        );
        return;
      }
    }
    void logOnboardingRun(athleteId, startedAt, result.inputTokens, result.outputTokens);

    const resolved = enforceGuardrails(state, result.output);
    let working: V3OnboardingState = {
      ...resolved.state,
      last_processed_key: dedupKey ?? state.last_processed_key,
    };
    let message = resolved.message;
    let chips = resolved.chips;

    // Race lookup — a second, slower call, only on the race-naming turn. A
    // confirmed race's distance drives goal_distance in code (resolveRace);
    // otherwise a stated out-of-bucket distance the model surfaced is bucketed (or
    // pocketed) here. Mutually exclusive: the lookup already carries a distance.
    // `pocketOfferOwnsMessage` marks the bare stated-distance offer for the
    // reflection composition's boundary lead (the race-lookup variant carries its
    // own "Found it — … Heads up though:" lead already).
    let pocketOfferOwnsMessage = false;
    if (result.output.race_lookup_query && !resolved.overridden) {
      const lr = await resolveRace(athleteId, chatId, result.output.race_lookup_query, working);
      working = lr.state;
      message = lr.message;
      chips = lr.chips;
    } else if (result.output.goal_distance_mi != null && !resolved.overridden) {
      const sd = applyStatedDistance(working, result.output.goal_distance_mi, text);
      working = sd.state;
      if (sd.pocket) {
        message = sd.message;
        chips = sd.chips;
        pocketOfferOwnsMessage = true;
      }
    }

    // A stated periodic volume goal ("100 miles a month") — ULTRA_SUPPORT §6 is
    // deferred, so the engine doesn't build toward it. The clause always rides to
    // the intents; when it's the headline goal (newly stated, no race in play),
    // this turn states the boundary plainly and redirects to the two things the
    // engine CAN do. Deliberately not an `else` branch: a volume target alongside
    // a race turn still demotes to an intent without touching that turn's message.
    let volumeBoundaryFired = false;
    if (result.output.volume_goal && !resolved.overridden) {
      const vg = applyVolumeGoal(working, result.output.volume_goal, result.output);
      working = vg.state;
      if (vg.boundary) {
        volumeBoundaryFired = true;
        message = volumeBoundaryBody(result.output.volume_goal.period);
        chips = VOLUME_REDIRECT_CHIPS;
        pocketOfferOwnsMessage = true; // the boundary reads under the mirror's lead
      }
    }

    // A pocket opening ON the reflection turn gets the reflection chip set — the
    // decline there means "you misread me" (the redo path), not "not now" (R2).
    if (
      working.out_of_catalog?.consent === 'pending' &&
      !state.out_of_catalog &&
      !hasReflected(state)
    ) {
      chips = REFLECTION_POCKET_CHIPS;
    }

    // Settle a pocket that was pending BEFORE this turn and answered in prose (the
    // chip path resolves in the fast path above). V3-W8.
    if (
      state.out_of_catalog?.consent === 'pending' &&
      working.out_of_catalog?.consent === 'pending'
    ) {
      working = reconcilePocket(state.out_of_catalog, working);
    }

    // Deterministic numeric backstop (§5.1): never let an implausible finish time
    // reach the plan. Runs whenever this turn touched target_time — AFTER the
    // pocket/race-lookup block, because a pocketed goal validates against its real
    // distance, which the same turn may have just set ("1 mile in under 5 minutes"
    // opens the pocket AND fills target_time; R1 fix 5). When the backstop and the
    // pocket both want the turn, the backstop's message wins — the pocket stays
    // pending in state and summarizeState/reconcilePocket settle it next turn.
    // Cross-fire: the trigger also fires when this turn FILLED goal_distance
    // against an already-set target time — the mile enum-bypass (the model maps
    // "a mile" straight to the '5k' bucket, skipping the goal_distance_mi path
    // and the catalog floor with it; 2026-06-10 staging). The implausible pair is
    // the deterministic tell. Model fills only: a race-lookup-derived bucket is a
    // direct state write, never in output.fills, so a confirmed race can't trip
    // this; a typed pocket-accept can't either (reconcilePocket ran above, so the
    // ooc-miles envelope validates the time against the real distance).
    const touchedTarget = result.output.fills.some((f) => f.slot === 'target_time');
    const distanceCrossFire =
      !touchedTarget &&
      result.output.fills.some((f) => f.slot === 'goal_distance') &&
      working.slots.target_time?.value != null;
    let backstopFired = false;
    if (touchedTarget || distanceCrossFire) {
      const backstop = backstopTargetTime(working, distanceCrossFire);
      if (backstop) {
        backstopFired = true;
        working = backstop.state;
        message = backstop.message;
        chips = backstop.chips;
        pocketOfferOwnsMessage = false;
      }
    }

    // A fired backstop owns the turn even against a generate — building the plan
    // now would silently drop the athlete's goal time (the "sub-5 evaporated" bug).
    // Same for a volume boundary: generating past it is the "happily agreed to
    // 100 miles a month" failure all over again.
    if (resolved.action === 'generate' && !backstopFired && !volumeBoundaryFired) {
      await finishOnboarding(athlete, chatId, working);
      return;
    }

    await saveV3State(athleteId, working);
    await sendV3(
      athleteId,
      chatId,
      composeReflection(result.output.reflection, message, pocketOfferOwnsMessage),
      chipsKeyboard(chips),
    );
  });
}

// ---------------------------------------------------------------------------
// Numeric backstop
// ---------------------------------------------------------------------------

function backstopTargetTime(
  state: V3OnboardingState,
  distanceTriggered = false,
): { state: V3OnboardingState; message: string; chips: Chip[] } | null {
  const tt = state.slots.target_time;
  if (!tt || typeof tt.value !== 'number') return null;
  const heldTime = tt.value;

  // A pocketed goal validates against its REAL distance via the pace envelope —
  // 300s is implausible for the 5k bucket but right for the mile behind the proxy
  // (R1 fix 5). The bucket table stays the fallback when no concrete distance
  // exists; no distance at all → nothing to validate against yet.
  const oocMiles = state.out_of_catalog?.distance_mi;
  const distance = state.slots.goal_distance?.value as GoalDistanceValue | undefined;
  let res;
  let forLabel: string;
  if (oocMiles != null) {
    res = resolveFinishTimeForMiles(tt.value, oocMiles);
    const rounded = Math.round(oocMiles);
    forLabel = rounded === 1 ? 'the mile' : `${rounded} miles`;
  } else if (distance) {
    res = resolveFinishTime(tt.value, distance);
    forLabel = `a ${distance}`;
  } else {
    return null;
  }
  if (res.status === 'ok' || res.status === 'no_range') return null;

  // Drop the implausible value so it can't be committed; ask for the right reading.
  const cleared: SlotState = {
    ...state.slots,
    target_time: mkSlot<number>(null, 'unknown', false),
  };
  const next = { ...state, slots: cleared };

  if (res.status === 'ambiguous') {
    return {
      state: next,
      message: 'Want to make sure I have that right — which did you mean?',
      chips: [
        { label: res.asHours.label, value: res.asHours.label },
        { label: res.asMinutes.label, value: res.asMinutes.label },
      ],
    };
  }
  // out_of_range. On a distance-triggered fire the DISTANCE may be the wrong half
  // of the pair (the mile enum-bypass: 5:00 was right, '5k' was the model's
  // invention) — question the pairing instead of inviting the same time again.
  if (distanceTriggered) {
    return {
      state: next,
      message: `Hold on — I had ${formatShortTarget(heldTime)} as your goal time, but that doesn't fit ${forLabel}. Is the distance actually different, or should we set a new time for ${forLabel}?`,
      chips: [],
    };
  }
  const units =
    oocMiles != null && oocMiles < CATALOG_FLOOR_MI ? 'minutes and seconds' : 'hours and minutes';
  return {
    state: next,
    message: `That time doesn't look right for ${forLabel}. What's your goal finish, as ${units}?`,
    chips: [],
  };
}

// ---------------------------------------------------------------------------
// Race lookup
// ---------------------------------------------------------------------------

async function resolveRace(
  athleteId: string,
  chatId: number | string,
  query: string,
  state: V3OnboardingState,
): Promise<{ state: V3OnboardingState; message: string; chips: Chip[] }> {
  await sendV3(athleteId, chatId, 'Let me look that up…');
  const r = await lookupRace(query, athleteId);

  if (r.ok && 'found' in r) {
    const f = r.found;
    // A past date from the race DB is a stale edition (last year's running) — it
    // must not land `stated`+confirmed and bypass the merge-time guard (R1 fix 3).
    // Treat it as absent; the gate asks for the date like any dateless race.
    const todayISO = todayISOInTz(
      (state.slots.timezone?.value as string | null) ?? 'America/Los_Angeles',
    );
    const date = f.date && !isPastISODate(f.date, todayISO) ? f.date : null;
    const dateStr = date ?? 'date still TBD';
    const derived = f.distance_mi != null ? deriveBucketFromMiles(f.distance_mi) : null;

    // Out of catalog (e.g. Western States, 100 mi): the consent turn doubles as the
    // race confirm, so name + date land `stated`; a `yes` takes the proxy.
    if (f.distance_mi != null && derived === null) {
      const slots: SlotState = {
        ...state.slots,
        goal_type: state.slots.goal_type ?? mkSlot('race', 'inferred', true),
        goal_race: mkSlot(f.canonical_name, 'stated', true),
        goal_date: date ? mkSlot(date, 'stated', true) : state.slots.goal_date,
      };
      return {
        state: setPocket({ ...state, slots }, f.canonical_name, f.distance_mi),
        message: `Found it — ${f.canonical_name}, ${dateStr}. Heads up though: ${pocketBody(f.distance_mi)}`,
        chips: POCKET_CHIPS,
      };
    }

    const slots: SlotState = {
      ...state.slots,
      goal_type: state.slots.goal_type ?? mkSlot('race', 'inferred', true),
      // System-resolved → unconfirmed: the athlete confirms the match (plan-driving).
      goal_race: mkSlot(f.canonical_name, 'inferred', false),
      goal_date: date ? mkSlot(date, 'inferred', false) : state.slots.goal_date,
      // The bucket comes from the number in code, never the model (§5.3). `stated`
      // (the athlete confirms the race) skips the redundant distance-confirm gate.
      goal_distance: derived ? mkSlot(derived, 'stated', true) : state.slots.goal_distance,
    };
    return {
      // An in-catalog race supersedes any open or accepted pocket — without this
      // an accepted pocket's distance_mi survives the pivot and poisons the new
      // race's row at commit (the stale-pocket bug, 2026-06-10 pressure-test).
      state: supersedePocket({ ...state, slots }),
      message: `Found it — ${f.canonical_name}, ${dateStr}. That the one?`,
      chips: [
        { label: "That's it", value: 'yes' },
        { label: 'Not quite', value: 'not that race' },
      ],
    };
  }

  if (r.ok && 'ambiguous' in r) {
    const opts = r.ambiguous.slice(0, 3);
    return {
      state,
      message: 'A few races go by that name — which one?',
      chips: opts.map((o) => ({
        label: `${o.canonical_name}${o.date ? ` (${o.date})` : ''}`.slice(0, 48),
        value: o.canonical_name,
      })),
    };
  }

  // not_found / error
  return {
    state,
    message:
      "I couldn't pin that race down. What's the date — and the city, if the name's a common one?",
    chips: [],
  };
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

async function finishOnboarding(
  athlete: AthleteRow,
  chatId: number | string,
  state: V3OnboardingState,
): Promise<void> {
  const athleteId = athlete.id;

  // v4 entry off-ramp (§4.3): a no-event signup is NOT given a keep_fit plan. Two
  // beats. First reach of the generate gate → the honest offer (no chips — naming a
  // goal here flows back through the normal engine, since phase stays 'intake'). If
  // they come back still event-less, the gate is reached again with off_ramp_offered
  // set → acknowledge + capture a check-back. The athlete is dormant either way.
  if (isNoEventGoal(state)) {
    if (!state.off_ramp_offered) {
      await enterDormant(athleteId, null);
      await saveV3State(athleteId, { ...state, phase: 'intake', off_ramp_offered: true });
      await sendV3(athleteId, chatId, OFF_RAMP_OFFER);
      await alertOffRamp(athleteId);
      return;
    }
    await saveV3State(athleteId, { ...state, phase: 'off_ramp' });
    await sendV3(athleteId, chatId, ACK_NO_GOAL, chipsKeyboard(CHECK_BACK_CHIPS));
    return;
  }

  // A real event after a prior off-ramp: wake the dormant athlete before the plan
  // commits so dailies resume (no-op for a never-dormant athlete — scoped to
  // pause_reason 'dormant').
  await exitDormant(athleteId);

  // Commit once — races/injuries inserts aren't idempotent, so guard a retry.
  let committed = state;
  if (!state.committed) {
    try {
      await commitSlotsSafe(athleteId, state);
    } catch (err) {
      // Commit refuses a past target_date outright (R1 fix 3 / T-9): with the
      // merge-time guard upstream this should be unreachable, so log loudly,
      // reset the date, and route back to intake instead of generating.
      if ((err as { code?: string })?.code === 'PAST_TARGET_DATE') {
        console.error('[v3] commit refused: past target_date', err);
        await sendDavidAlert(
          `v3 commit refused for ${athleteId}: past target_date (${String(err)})`,
        ).catch(() => {});
        await saveV3State(athleteId, {
          ...state,
          slots: { ...state.slots, goal_date: mkSlot<string>(null, 'unknown', false) },
          phase: 'intake',
          recap_shown: undefined,
        });
        await sendV3(
          athleteId,
          chatId,
          "That race date looks like it's already behind us — what's the actual date?",
        );
        return;
      }
      console.error('[v3] commitSlots failed', err);
      await sendDavidAlert(`v3 commit failed for ${athleteId}: ${String(err)}`).catch(() => {});
      await sendV3(
        athleteId,
        chatId,
        'Hit a snag saving your profile — give me a moment and message me again.',
      );
      return;
    }
    committed = { ...state, committed: true };
    await saveV3State(athleteId, { ...committed, phase: 'recap' });
  }

  let preview: string;
  try {
    // Lazy-imported so the router's static graph stays free of the v2 step/grammy
    // module init (keeps bot.ts's import of the router light).
    const { generateAndPersistPlan } = await import('../plan-gen');
    const { formatPreview } = await import('../steps/04-plan-preview');
    const { plan, params } = await generateAndPersistPlan(athleteId); // idempotent
    preview = formatPreview(plan, params, { intents: state.intents });
  } catch (err) {
    console.error('[v3] plan generation failed', err);
    await sendDavidAlert(`v3 plan gen failed for ${athleteId}: ${String(err)}`).catch(() => {});
    await sendV3(
      athleteId,
      chatId,
      "I hit a snag building your plan — I've pinged David and he'll sort it.",
    );
    return;
  }

  await saveV3State(athleteId, { ...committed, phase: 'complete' });

  // The athlete is now real — grant the one-time $5 signup credit (idempotent;
  // METERING_PAYMENTS.md §4). Never let a billing-grant hiccup block completion.
  try {
    const { grantSignupCredit } = await import('@/server/billing/credits');
    await grantSignupCredit(athleteId);
  } catch (err) {
    console.error('[v3] signup credit grant failed', err);
    await sendDavidAlert(`v3 signup grant failed for ${athleteId}: ${String(err)}`).catch(() => {});
  }

  await sendV3(athleteId, chatId, preview);
  await sendV3(
    athleteId,
    chatId,
    "That's your starting plan. I'll check in with you most mornings. A few things you can do now:",
    nextActionsKeyboard(),
  );
  await alertComplete(athleteId);
}

// commitSlots lives in commit.ts; imported lazily to keep the module graph shallow.
async function commitSlotsSafe(athleteId: string, state: V3OnboardingState): Promise<void> {
  const { commitSlots } = await import('./commit');
  await commitSlots(athleteId, state);
}

/** The athlete's name for a David alert, falling back to the id. */
async function athleteLabel(athleteId: string): Promise<string> {
  const { data } = await supabaseAdmin()
    .from('athletes')
    .select('name')
    .eq('id', athleteId)
    .maybeSingle();
  return data?.name ?? athleteId;
}

async function alertComplete(athleteId: string): Promise<void> {
  await sendDavidAlert(
    `${await athleteLabel(athleteId)} finished onboarding (v3) — template plan active.`,
  ).catch(() => {});
}

/** v4 off-ramp alert: a no-event signup went dormant with no plan (§4.3). */
async function alertOffRamp(athleteId: string): Promise<void> {
  await sendDavidAlert(
    `${await athleteLabel(athleteId)} hit the no-event off-ramp (v4) — dormant, no plan.`,
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// /edit_profile (W3): the fork + the "Finish my profile" known-gaps walk
// ---------------------------------------------------------------------------

function gapQuestion(key: KnownGapKey): string {
  return KNOWN_GAPS[key].question;
}

/** Dispatch an /edit_profile fork tap. "Update something" just opens the floor —
 *  the athlete's next message is folded in by the engine (mid-onboarding) or the
 *  coach (after). "Finish my profile" starts the gap-walk. */
async function handleEditFork(
  athlete: AthleteRow,
  chatId: number | string,
  value: 'edit:update' | 'edit:finish',
  label: string | null,
): Promise<void> {
  await logInbound(athlete.id, label ?? value);
  if (value === 'edit:update') {
    await sendV3(athlete.id, chatId, 'Go ahead — tell me what to add or change.');
    return;
  }
  await startGapWalk(athlete, chatId);
}

/** Begin the "Finish my profile" walk: queue the open known-gaps and ask the
 *  first. No-op-ish with a friendly note if there's nothing to fill or the
 *  athlete is still mid-onboarding (gaps aren't seeded until completion). */
async function startGapWalk(athlete: AthleteRow, chatId: number | string): Promise<void> {
  const state = await loadV3State(athlete.id);
  if (!state) return;

  if (state.phase !== 'complete') {
    await sendV3(
      athlete.id,
      chatId,
      "We're still going through it — keep chatting with me and I'll cover everything.",
    );
    return;
  }

  const { open } = parseKnownGaps(await loadKnownGapsContent(athlete.id));
  if (open.length === 0) {
    await sendV3(
      athlete.id,
      chatId,
      "Your profile's all filled in — nothing left for me to ask. Anything you want to change, just tell me.",
    );
    return;
  }

  const first = open[0]!; // length > 0 checked above
  await saveV3State(athlete.id, {
    ...state,
    edit_mode: { kind: 'finish_gaps', current_gap: first, remaining: open.slice(1) },
  });
  await sendV3(athlete.id, chatId, gapQuestion(first));
}

/** One turn of the gap-walk: extract the answer to the current gap, write it
 *  into known_gaps.md if it landed, then ask the next gap or wrap up. The queue
 *  (`remaining`) guarantees each gap is asked once and the walk terminates even
 *  when an answer doesn't parse. Writes only known_gaps.md — no DB re-commit
 *  (the coach reads the filled gap from there). */
async function runGapWalkTurn(
  { athlete, chatId, text, dedupKey, logBody }: TurnInput,
  state: V3OnboardingState,
): Promise<void> {
  const athleteId = athlete.id;
  const em = state.edit_mode;
  if (em?.kind !== 'finish_gaps') return;
  if (dedupKey && state.last_processed_key === dedupKey) return; // Telegram retry

  await logInbound(athleteId, logBody ?? text);

  await withTyping(chatId, async () => {
    // Reuse the engine's extraction to parse the freeform answer into slots; we
    // ignore its message/next_action — the walk owns the conversation.
    let slots = state.slots;
    try {
      const history = await loadRecentHistory(athleteId, 8);
      const startedAt = new Date().toISOString();
      const result = await callExtractAndAdvance({ state, history, latest: text, athleteId });
      void logOnboardingRun(athleteId, startedAt, result.inputTokens, result.outputTokens);
      slots = mergeFills(state.slots, result.output.fills);
    } catch (err) {
      console.error('[v3] gap-walk extract failed', err);
      // Fall through — still advance so a parse failure can't strand the walk.
    }

    // Persist every gap the answer just filled (stated only) — not only the one
    // asked: "I'm 42, and I run before work" fills age AND schedule_constraints,
    // and both are worth capturing while the athlete is volunteering them.
    const gapValues = slotsToGaps(slots);
    const { filled } = parseKnownGaps(await loadKnownGapsContent(athleteId));
    const merged = { ...filled, ...gapValues };
    if (Object.keys(merged).some((k) => merged[k as KnownGapKey] !== filled[k as KnownGapKey])) {
      // Keep the no-race / keep_fit athlete's race-only gaps suppressed: the file
      // is re-rendered whole, so without this they'd reappear as [open] (V3-W7).
      const noRace = slots.goal_type?.value === 'general_fitness';
      await seedKnownGapsFromFilled(athleteId, merged, { excludeRaceOnly: noRace }).catch((e) =>
        console.error('[v3] gap-walk write failed', e),
      );
    }

    const [nextGap, ...rest] = em.remaining;
    if (nextGap) {
      await saveV3State(athleteId, {
        ...state,
        slots,
        edit_mode: { kind: 'finish_gaps', current_gap: nextGap, remaining: rest },
        last_processed_key: dedupKey ?? state.last_processed_key,
      });
      await sendV3(athleteId, chatId, gapQuestion(nextGap));
    } else {
      await saveV3State(athleteId, {
        ...state,
        slots,
        edit_mode: undefined,
        last_processed_key: dedupKey ?? state.last_processed_key,
      });
      await sendV3(
        athleteId,
        chatId,
        "Got it — that's everything. I'll put it to work in your next update.",
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Public entry points (called from bot.ts)
// ---------------------------------------------------------------------------

export async function handleV3Message(ctx: Context, athlete: AthleteRow): Promise<void> {
  const chatId = ctx.chat!.id;
  const text = ctx.message?.text ?? '';
  const messageId = ctx.message?.message_id;
  await runTurn({
    athlete,
    chatId,
    text,
    dedupKey: messageId != null ? `m:${messageId}` : undefined,
  });
}

export async function handleV3Callback(
  ctx: Context,
  athlete: AthleteRow,
  data: string,
): Promise<void> {
  await ctx.answerCallbackQuery();

  const value = data.slice(CHIP_PREFIX.length);
  const chatId = ctx.chat?.id ?? ctx.from!.id;

  // Recover the human label off the tapped keyboard for the transcript, then
  // collapse the keyboard to a "✅ <choice>" record so it can't be re-tapped.
  const msg = ctx.callbackQuery?.message;
  const rows = msg && 'reply_markup' in msg ? msg.reply_markup?.inline_keyboard : undefined;
  const label = labelForTap(rows, data);
  const collapsed = selectionKeyboardFromTap(rows, data);
  if (collapsed)
    await ctx.editMessageReplyMarkup({ reply_markup: collapsed }).catch(() => undefined);
  else await ctx.editMessageReplyMarkup().catch(() => undefined);

  // /edit_profile fork taps dispatch to the menu, not a conversational turn (W3).
  if (value === 'edit:update' || value === 'edit:finish') {
    await handleEditFork(athlete, chatId, value, label);
    return;
  }

  await runTurn({
    athlete,
    chatId,
    text: value,
    dedupKey: ctx.callbackQuery?.id ? `c:${ctx.callbackQuery.id}` : undefined,
    logBody: label ?? value,
    fromChip: true,
  });
}
