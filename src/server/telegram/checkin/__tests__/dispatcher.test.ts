import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('../wellness-log', () => ({ appendWellnessRow: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../bot', () => ({ sendAndLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('grammy', () => ({ Bot: vi.fn(), Context: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/server/agent/daily-checkin', () => ({
  runDailyCheckin: vi.fn().mockResolvedValue({
    telegramMessage: 'Solid check-in. Easy 6 miles today at RPE 4–5.',
    checkinLogEntry: 'Solid check-in. Easy 6 miles today at RPE 4–5.',
  }),
  appendCheckinEntry: vi.fn().mockResolvedValue(undefined),
  persistRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/server/strava/activities', () => ({
  hasStravaConnection: vi.fn().mockResolvedValue(true),
  StravaTokenBrokenError: class StravaTokenBrokenError extends Error {
    constructor(cause?: unknown) {
      super('Strava token refresh failed or was revoked');
      this.name = 'StravaTokenBrokenError';
      if (cause instanceof Error) this.cause = cause;
    }
  },
}));

import { supabaseAdmin } from '@/lib/db';
import { sendAndLog } from '../../bot';
import { appendWellnessRow } from '../wellness-log';
import { runDailyCheckin, appendCheckinEntry, persistRun } from '@/server/agent/daily-checkin';
import { hasStravaConnection, StravaTokenBrokenError } from '@/server/strava/activities';
import * as Sentry from '@sentry/nextjs';
import { handleCheckinCommand, handleWellnessMessage } from '../dispatcher';
import { READINESS_PROMPT, SORENESS_PROMPT, NOTE_PROMPT, CONCERNING_LINE } from '../wellness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'athlete-1';
const CHAT_ID = 42;

function makeCtx(text = 'hi') {
  return {
    chat: { id: CHAT_ID },
    reply: vi.fn().mockResolvedValue(undefined),
    message: { text },
  };
}

function makeAthlete(
  checkinState: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    id: ATHLETE_ID,
    telegram_chat_id: String(CHAT_ID),
    onboarding_state: { step: 7 },
    checkin_state: checkinState,
    timezone: 'America/Los_Angeles',
    ...extra,
  };
}

// Build a db mock that supports:
// - messages.insert
// - athletes.update().eq()
function makeDb() {
  const insertMock = vi.fn().mockResolvedValue({ error: null });
  const eqMock = vi.fn().mockResolvedValue({ error: null });
  const updateMock = vi.fn().mockReturnValue({ eq: eqMock });

  const db = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'messages') return { insert: insertMock };
      if (table === 'athletes') return { update: updateMock };
      return {};
    }),
    insertMock,
    updateMock,
    eqMock,
  };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// handleCheckinCommand
// ---------------------------------------------------------------------------
describe('handleCheckinCommand', () => {
  it('sets awaiting_readiness state and sends readiness prompt', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const ctx = makeCtx();
    const athlete = makeAthlete({});

    await handleCheckinCommand(ctx as AnyMock, athlete as AnyMock);

    // Check state was written
    expect(db.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        checkin_state: { sub_step: 'awaiting_readiness', partial: {} },
      }),
    );
    // Check readiness prompt was sent
    expect(sendAndLog).toHaveBeenCalledWith(ATHLETE_ID, CHAT_ID, READINESS_PROMPT);
  });

  it('replies with re-entry refusal when mid-checkin', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const ctx = makeCtx();
    const athlete = makeAthlete({ sub_step: 'awaiting_readiness', partial: {} });

    await handleCheckinCommand(ctx as AnyMock, athlete as AnyMock);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Already mid-check-in'));
    expect(db.updateMock).not.toHaveBeenCalled();
    expect(sendAndLog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleWellnessMessage — awaiting_readiness
// ---------------------------------------------------------------------------
describe('handleWellnessMessage — awaiting_readiness', () => {
  it('re-asks on invalid input without advancing state', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const ctx = makeCtx('ten');
    const athlete = makeAthlete({ sub_step: 'awaiting_readiness', partial: {} });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    // State NOT advanced
    expect(db.updateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        checkin_state: expect.objectContaining({ sub_step: 'awaiting_soreness' }),
      }),
    );
    // Re-ask sent
    expect(sendAndLog).toHaveBeenCalledWith(
      ATHLETE_ID,
      CHAT_ID,
      expect.stringContaining(READINESS_PROMPT),
    );
  });

  it('advances to awaiting_soreness on valid input', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const ctx = makeCtx('7');
    const athlete = makeAthlete({ sub_step: 'awaiting_readiness', partial: {} });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    expect(db.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        checkin_state: { sub_step: 'awaiting_soreness', partial: { readiness: 7 } },
      }),
    );
    expect(sendAndLog).toHaveBeenCalledWith(ATHLETE_ID, CHAT_ID, SORENESS_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// handleWellnessMessage — awaiting_soreness
// ---------------------------------------------------------------------------
describe('handleWellnessMessage — awaiting_soreness', () => {
  it('re-asks on invalid input', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const ctx = makeCtx('very sore');
    const athlete = makeAthlete({
      sub_step: 'awaiting_soreness',
      partial: { readiness: 7 },
    });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    expect(sendAndLog).toHaveBeenCalledWith(
      ATHLETE_ID,
      CHAT_ID,
      expect.stringContaining(SORENESS_PROMPT),
    );
  });

  it('advances to awaiting_note on valid score-only input', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const ctx = makeCtx('3');
    const athlete = makeAthlete({
      sub_step: 'awaiting_soreness',
      partial: { readiness: 7 },
    });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    expect(db.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        checkin_state: {
          sub_step: 'awaiting_note',
          partial: { readiness: 7, soreness_score: 3, soreness_body_part: null },
        },
      }),
    );
    expect(sendAndLog).toHaveBeenCalledWith(ATHLETE_ID, CHAT_ID, NOTE_PROMPT);
  });

  it('advances to awaiting_note with body part', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const ctx = makeCtx('4 left hamstring');
    const athlete = makeAthlete({
      sub_step: 'awaiting_soreness',
      partial: { readiness: 7 },
    });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    expect(db.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        checkin_state: {
          sub_step: 'awaiting_note',
          partial: { readiness: 7, soreness_score: 4, soreness_body_part: 'left hamstring' },
        },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleWellnessMessage — awaiting_note / onWellnessComplete
// ---------------------------------------------------------------------------
describe('handleWellnessMessage — awaiting_note', () => {
  it('calls appendWellnessRow, clears state, calls runDailyCheckin, and sends coaching response', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const ctx = makeCtx("felt good on yesterday's run");
    const athlete = makeAthlete({
      sub_step: 'awaiting_note',
      partial: { readiness: 7, soreness_score: 3, soreness_body_part: null },
    });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    expect(appendWellnessRow).toHaveBeenCalledOnce();
    const [, entry] = (appendWellnessRow as AnyMock).mock.calls[0];
    expect(entry.readiness).toBe(7);
    expect(entry.soreness).toBe(3);
    expect(entry.body_part).toBe('—');
    expect(entry.note).toBe("felt good on yesterday's run");

    // State cleared
    expect(db.updateMock).toHaveBeenCalledWith(expect.objectContaining({ checkin_state: {} }));

    // runDailyCheckin called with correct wellness input
    expect(runDailyCheckin).toHaveBeenCalledOnce();
    const [calledAthleteId, calledWellness] = (runDailyCheckin as AnyMock).mock.calls[0];
    expect(calledAthleteId).toBe(ATHLETE_ID);
    expect(calledWellness.readiness).toBe(7);
    expect(calledWellness.soreness_score).toBe(3);
    expect(calledWellness.soreness_body_part).toBeNull();
    expect(calledWellness.note).toBe("felt good on yesterday's run");

    // Coaching response sent to Telegram
    expect(sendAndLog).toHaveBeenCalledWith(
      ATHLETE_ID,
      CHAT_ID,
      'Solid check-in. Easy 6 miles today at RPE 4–5.',
    );

    // checkin_log.md written
    expect(appendCheckinEntry).toHaveBeenCalledOnce();
    const [entryAthleteId, , entryContent] = (appendCheckinEntry as AnyMock).mock.calls[0];
    expect(entryAthleteId).toBe(ATHLETE_ID);
    expect(entryContent).toBe('Solid check-in. Easy 6 miles today at RPE 4–5.');
  });

  it("skips note on 'skip' reply", async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const ctx = makeCtx('skip');
    const athlete = makeAthlete({
      sub_step: 'awaiting_note',
      partial: { readiness: 6, soreness_score: 2, soreness_body_part: null },
    });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    const [, entry] = (appendWellnessRow as AnyMock).mock.calls[0];
    expect(entry.note).toBe('—');
  });

  it('does NOT send concerning line for normal values', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const ctx = makeCtx('skip');
    const athlete = makeAthlete({
      sub_step: 'awaiting_note',
      partial: { readiness: 7, soreness_score: 3, soreness_body_part: null },
    });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    const calls = (sendAndLog as AnyMock).mock.calls as AnyMock[];
    const sentTexts = calls.map(([, , text]: AnyMock) => text as string);
    expect(sentTexts.every((t) => !t.includes('closer look'))).toBe(true);
  });

  it('sends concerning line when readiness <= 4', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const ctx = makeCtx('skip');
    const athlete = makeAthlete({
      sub_step: 'awaiting_note',
      partial: { readiness: 3, soreness_score: 2, soreness_body_part: null },
    });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    expect(sendAndLog).toHaveBeenCalledWith(ATHLETE_ID, CHAT_ID, CONCERNING_LINE);
  });

  it('sends concerning line when soreness >= 7 with no body part', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const ctx = makeCtx('skip');
    const athlete = makeAthlete({
      sub_step: 'awaiting_note',
      partial: { readiness: 7, soreness_score: 7, soreness_body_part: null },
    });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    expect(sendAndLog).toHaveBeenCalledWith(ATHLETE_ID, CHAT_ID, CONCERNING_LINE);
  });

  it('sends concerning line when soreness >= 6 with body part', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const ctx = makeCtx('skip');
    const athlete = makeAthlete({
      sub_step: 'awaiting_note',
      partial: { readiness: 7, soreness_score: 6, soreness_body_part: 'left knee' },
    });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    expect(sendAndLog).toHaveBeenCalledWith(ATHLETE_ID, CHAT_ID, CONCERNING_LINE);
  });
});

// ---------------------------------------------------------------------------
// onWellnessComplete — Claude failure fallback
// ---------------------------------------------------------------------------
describe('onWellnessComplete — Claude failure fallback', () => {
  it('sends fallback reply and captures to Sentry when runDailyCheckin throws', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    (runDailyCheckin as AnyMock).mockRejectedValueOnce(new Error('Claude timeout'));

    const ctx = makeCtx('skip');
    const athlete = makeAthlete({
      sub_step: 'awaiting_note',
      partial: { readiness: 5, soreness_score: 2, soreness_body_part: null },
    });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    // Fallback sent
    expect(sendAndLog).toHaveBeenCalledWith(
      ATHLETE_ID,
      CHAT_ID,
      expect.stringContaining('Coaching response delayed'),
    );

    // Sentry captured
    expect(Sentry.captureException).toHaveBeenCalledOnce();

    // checkin_log.md NOT written on failure
    expect(appendCheckinEntry).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onWellnessComplete — Strava hard requirement
// ---------------------------------------------------------------------------
describe('onWellnessComplete — Strava hard requirement', () => {
  it('no Strava connection: sends refusal, records agent_runs row, does not call agent', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    (hasStravaConnection as AnyMock).mockResolvedValueOnce(false);

    const ctx = makeCtx('skip');
    const athlete = makeAthlete({
      sub_step: 'awaiting_note',
      partial: { readiness: 7, soreness_score: 3, soreness_body_part: null },
    });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    // runDailyCheckin must NOT be called
    expect(runDailyCheckin).not.toHaveBeenCalled();

    // Refusal message sent, mentions wellness values and /connect_strava
    const calls = (sendAndLog as AnyMock).mock.calls as AnyMock[];
    const sentTexts = calls.map(([, , text]: AnyMock) => text as string);
    const refusal = sentTexts.find((t) => t.includes('/connect_strava'));
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('readiness 7');
    expect(refusal).toContain('soreness 3');

    // persistRun called with strava_not_connected error and zero tokens
    expect(persistRun).toHaveBeenCalledOnce();
    const [, , inputTokens, outputTokens, , error] = (persistRun as AnyMock).mock
      .calls[0] as AnyMock[];
    expect(inputTokens).toBe(0);
    expect(outputTokens).toBe(0);
    expect(error).toBe('strava_not_connected');

    // checkin_log.md NOT written
    expect(appendCheckinEntry).not.toHaveBeenCalled();
  });

  it('broken Strava token: sends broken-token refusal, does not capture to Sentry', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    (hasStravaConnection as AnyMock).mockResolvedValueOnce(true);
    (runDailyCheckin as AnyMock).mockRejectedValueOnce(new StravaTokenBrokenError());

    const ctx = makeCtx('skip');
    const athlete = makeAthlete({
      sub_step: 'awaiting_note',
      partial: { readiness: 6, soreness_score: 4, soreness_body_part: 'left knee' },
    });

    await handleWellnessMessage(ctx as AnyMock, athlete as AnyMock);

    // Broken-token refusal sent
    const calls = (sendAndLog as AnyMock).mock.calls as AnyMock[];
    const sentTexts = calls.map(([, , text]: AnyMock) => text as string);
    const refusal = sentTexts.find((t) => t.includes('/connect_strava'));
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('readiness 6');
    expect(refusal).toContain('soreness 4');
    expect(refusal).toContain('broke');

    // Sentry must NOT be called — broken token is athlete-side, not a system error
    expect(Sentry.captureException).not.toHaveBeenCalled();

    // checkin_log.md NOT written
    expect(appendCheckinEntry).not.toHaveBeenCalled();
  });
});
