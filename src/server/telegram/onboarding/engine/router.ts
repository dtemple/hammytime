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
import { KNOWN_GAPS, type KnownGapKey } from '@/lib/known-gaps';
import { loadV3State, saveV3State, type V3OnboardingState } from '../slots/slot-state';
import { slotsToGaps, type GoalDistanceValue, type SlotState } from '../slots/schema';
import { slotValue } from '../slots/provenance';
import {
  loadKnownGapsContent,
  parseKnownGaps,
  seedKnownGapsFromFilled,
} from '../known-gaps-memory';
import { callExtractAndAdvance, logOnboardingRun, type Chip } from './extract-and-advance';
import { enforceGuardrails, mergeFills, resolveConfirmAndAdvance } from './guardrails';
import { loadRecentHistory } from './history';
import { resolveFinishTime } from './numeric';
import { withTyping } from './typing';

type AthleteRow = Database['public']['Tables']['athletes']['Row'];

const CHIP_PREFIX = 'v3:';

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

  await logInbound(athleteId, logBody ?? text);

  await withTyping(chatId, async () => {
    const history = await loadRecentHistory(athleteId, 12);
    const startedAt = new Date().toISOString();

    let result;
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
    void logOnboardingRun(athleteId, startedAt, result.inputTokens, result.outputTokens);

    const resolved = enforceGuardrails(state, result.output);
    let working: V3OnboardingState = {
      ...resolved.state,
      last_processed_key: dedupKey ?? state.last_processed_key,
    };
    let message = resolved.message;
    let chips = resolved.chips;

    // Deterministic numeric backstop (§5.1): never let an implausible finish time
    // reach the plan. Runs whenever this turn touched target_time.
    const touchedTarget = result.output.fills.some((f) => f.slot === 'target_time');
    if (touchedTarget) {
      const backstop = backstopTargetTime(working);
      if (backstop) {
        working = backstop.state;
        message = backstop.message;
        chips = backstop.chips;
      }
    }

    // Race lookup — a second, slower call, only on the race-naming turn.
    if (result.output.race_lookup_query && !resolved.overridden) {
      const lr = await resolveRace(athleteId, chatId, result.output.race_lookup_query, working);
      working = lr.state;
      message = lr.message;
      chips = lr.chips;
    }

    if (resolved.action === 'generate') {
      await finishOnboarding(athlete, chatId, working);
      return;
    }

    await saveV3State(athleteId, working);
    await sendV3(athleteId, chatId, message, chipsKeyboard(chips));
  });
}

// ---------------------------------------------------------------------------
// Numeric backstop
// ---------------------------------------------------------------------------

function backstopTargetTime(
  state: V3OnboardingState,
): { state: V3OnboardingState; message: string; chips: Chip[] } | null {
  const tt = state.slots.target_time;
  const distance = state.slots.goal_distance?.value as GoalDistanceValue | undefined;
  if (!tt || typeof tt.value !== 'number' || !distance) return null;

  const res = resolveFinishTime(tt.value, distance);
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
  // out_of_range
  return {
    state: next,
    message: `That time doesn't look right for a ${distance}. What's your goal finish, as hours and minutes?`,
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
    const slots: SlotState = {
      ...state.slots,
      goal_type: state.slots.goal_type ?? mkSlot('race', 'inferred', true),
      // System-resolved → unconfirmed: the athlete confirms the match (plan-driving).
      goal_race: mkSlot(f.canonical_name, 'inferred', false),
      goal_date: f.date ? mkSlot(f.date, 'inferred', false) : state.slots.goal_date,
    };
    const dateStr = f.date ?? 'date still TBD';
    return {
      state: { ...state, slots },
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

  // Commit once — races/injuries inserts aren't idempotent, so guard a retry.
  let committed = state;
  if (!state.committed) {
    try {
      await commitSlotsSafe(athleteId, state);
    } catch (err) {
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
    preview = formatPreview(plan, params);
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

async function alertComplete(athleteId: string): Promise<void> {
  const { data } = await supabaseAdmin()
    .from('athletes')
    .select('name')
    .eq('id', athleteId)
    .maybeSingle();
  await sendDavidAlert(
    `${data?.name ?? athleteId} finished onboarding (v3) — template plan active.`,
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
      await seedKnownGapsFromFilled(athleteId, merged).catch((e) =>
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
