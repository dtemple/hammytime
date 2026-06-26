// V4-W6 — the drive loop. Runs one fixture conversation end to end against the
// real engine: seed state → feed the opening message → capture the bot reply +
// chips → simulator (or a forced move) responds → route it → repeat, until the
// conversation reaches plan-gen (completed), the off-ramp check-back (off-ramped),
// or a turn cap (did_not_converge → a failure).
//
// The router's I/O is stubbed by the vi.mock block in onboarding.eval.ts; this
// file is pure orchestration over the captured ports it's handed.

import { handleV3Message, handleV3Callback } from '../router';
import { sonnetCostUsd } from '../extract-and-advance';
import { initialV3State, type V3OnboardingState } from '../../slots/slot-state';
import { simulateAthlete } from './simulate-athlete';
import type {
  DriveOutcome,
  DriveResult,
  HarnessPorts,
  OnboardingFixture,
  TranscriptTurn,
} from './types';

const MAX_TURNS = 15;
const CHAT_ID = 99;

type AthleteArg = Parameters<typeof handleV3Message>[1];
type MessageCtx = Parameters<typeof handleV3Message>[0];
type CallbackCtx = Parameters<typeof handleV3Callback>[0];

function messageCtx(messageId: number, text: string): MessageCtx {
  return { chat: { id: CHAT_ID }, message: { message_id: messageId, text } } as unknown as MessageCtx;
}

function callbackCtx(id: string): CallbackCtx {
  return {
    chat: { id: CHAT_ID },
    from: { id: CHAT_ID },
    answerCallbackQuery: async () => undefined,
    editMessageReplyMarkup: async () => undefined,
    callbackQuery: { id, message: { reply_markup: { inline_keyboard: [] } } },
  } as unknown as CallbackCtx;
}

interface CoachReply {
  body: string;
  chips: Array<{ label: string; data: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function chipsFromOpts(opts: any): Array<{ label: string; data: string }> {
  const rows = opts?.reply_markup?.inline_keyboard;
  if (!Array.isArray(rows)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.flat().map((b: any) => ({ label: String(b.text), data: String(b.callback_data ?? '') }));
}

export async function driveFixture(
  fixture: OnboardingFixture,
  ports: HarnessPorts,
): Promise<DriveResult> {
  ports.reset();

  const athleteId = `eval-${fixture.name}`;
  const athlete = { id: athleteId } as unknown as AthleteArg;

  // Seed the in-memory state store. The fixture's initialState overrides the
  // post-Strava default (snapshot, pre-filled slots, off_ramp_offered, …).
  const seed: V3OnboardingState = {
    ...initialV3State(fixture.initialState?.strava_snapshot ?? null),
    phase: 'intake',
    ...fixture.initialState,
  };
  ports.stateStore.set(athleteId, seed);

  const transcript: TranscriptTurn[] = [];
  let simInTokens = 0;
  let simOutTokens = 0;
  let messageIdSeq = 1000;
  let callbackIdSeq = 1;
  let sentCursor = 0;

  // Drain newly-captured outbound coach messages into the transcript; return the
  // last one (what the athlete responds to next).
  function collectCoachReplies(): CoachReply | null {
    let last: CoachReply | null = null;
    for (; sentCursor < ports.sentMessages.length; sentCursor++) {
      const [, text, opts] = ports.sentMessages[sentCursor]!;
      const chips = chipsFromOpts(opts);
      transcript.push({ direction: 'coach', body: String(text), chips });
      ports.history.push({ direction: 'out', body: String(text) });
      last = { body: String(text), chips };
    }
    return last;
  }

  // Push the athlete's inbound to the history buffer BEFORE invoking the handler,
  // so the mocked loadRecentHistory (which drops the trailing inbound) returns the
  // prior turns while `latest` carries the current message — matching prod.
  function recordInbound(body: string): void {
    ports.history.push({ direction: 'in', body });
  }

  function terminalOutcome(): DriveOutcome | null {
    if (ports.recorded.generateAndPersistPlan > 0) return 'completed';
    if (ports.recorded.setCheckBack.length > 0) return 'offramped';
    const phase = ports.stateStore.get(athleteId)?.phase;
    if (phase === 'off_ramp') return 'offramped';
    return null;
  }

  // Turn 1: the opening athlete message.
  transcript.push({ direction: 'athlete', body: fixture.opening });
  recordInbound(fixture.opening);
  await handleV3Message(messageCtx(messageIdSeq++, fixture.opening), athlete);
  let coach = collectCoachReplies();

  let outcome: DriveOutcome = 'did_not_converge';
  // athlete turns already spent: 1 (the opening). Loop the rest.
  for (let turn = 2; turn <= MAX_TURNS; turn++) {
    const done = terminalOutcome();
    if (done) {
      outcome = done;
      break;
    }
    if (!coach) {
      // Engine sent nothing back — nothing to respond to. Record as non-convergence.
      break;
    }

    const forced = fixture.forcedMoves?.find((f) => f.turn === turn);
    let move: { kind: 'text'; body: string } | { kind: 'chip'; label: string };
    if (forced) {
      move = forced.move;
    } else {
      const sim = await simulateAthlete(
        fixture.persona,
        fixture.facts,
        transcript,
        coach.body,
        coach.chips,
      );
      simInTokens += sim.inputTokens;
      simOutTokens += sim.outputTokens;
      move = sim.reply;
    }

    if (move.kind === 'chip') {
      // Only an EXACT label match taps; a desync (a forced move naming a chip the
      // turn didn't offer) types the label instead of silently tapping the wrong
      // button. The simulator already validates labels, so this only guards forced
      // moves.
      const chip = coach.chips.find((c) => c.label === move.label);
      if (!chip) {
        transcript.push({ direction: 'athlete', body: move.label });
        recordInbound(move.label);
        await handleV3Message(messageCtx(messageIdSeq++, move.label), athlete);
      } else {
        transcript.push({ direction: 'athlete', body: chip.label });
        recordInbound(chip.label);
        await handleV3Callback(callbackCtx(`cb${callbackIdSeq++}`), athlete, chip.data);
      }
    } else {
      transcript.push({ direction: 'athlete', body: move.body });
      recordInbound(move.body);
      await handleV3Message(messageCtx(messageIdSeq++, move.body), athlete);
    }

    coach = collectCoachReplies() ?? coach;
  }

  // A terminal that landed exactly on the cap boundary.
  const finalTerminal = terminalOutcome();
  if (finalTerminal) outcome = finalTerminal;

  const finalState = ports.stateStore.get(athleteId) ?? seed;

  // Cost: engine turns (cache-aware) + simulator turns.
  let uncachedInputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  for (const t of ports.modelTurns) {
    uncachedInputTokens += t.inputTokens;
    outputTokens += t.outputTokens;
    cacheCreationTokens += t.cacheCreationTokens;
    cacheReadTokens += t.cacheReadTokens;
  }
  const engineCost = sonnetCostUsd({
    inputTokens: uncachedInputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
  });
  const simCost = sonnetCostUsd({ inputTokens: simInTokens, outputTokens: simOutTokens });

  return {
    fixture,
    outcome,
    transcript,
    finalState,
    ports: ports.recorded,
    modelTurns: ports.modelTurns,
    costUsd: engineCost + simCost,
    cacheCreationTokens,
    cacheReadTokens,
    uncachedInputTokens,
    failures: [],
  };
}
