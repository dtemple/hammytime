import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BACK_DATA } from '../back';

// V3-W0: every onboarding button tap is logged as an inbound message (the typed-text
// path already does via logInbound; the callback path didn't). The body is the
// human-readable label recovered off the tapped keyboard, falling back to the raw
// callback data when no label is resolvable.
const { stepA, insertSpy } = vi.hoisted(() => ({
  stepA: {
    id: 'a',
    questions: [],
    onComplete: vi.fn().mockResolvedValue(undefined),
    handleCallback: vi.fn().mockResolvedValue({ done: false, newPartial: {} }),
    handleBack: vi.fn().mockResolvedValue({ done: false, newPartial: {} }),
  },
  insertSpy: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock('../index', () => ({ onboardingSteps: [stepA] }));
vi.mock('../state', () => ({
  loadOnboardingState: vi.fn().mockResolvedValue({ step: 0, question: 0, partial: {} }),
  advanceQuestion: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../bot', () => ({
  sendAndLog: vi.fn().mockResolvedValue(undefined),
  telegramBot: () => ({ api: { sendMessage: vi.fn().mockResolvedValue(undefined) } }),
}));
vi.mock('@/server/admin/alerts', () => ({ sendDavidAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => ({ from: () => ({ insert: insertSpy }) }),
}));

import { handleOnboardingCallback } from '../dispatcher';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

function makeCtx(inlineKeyboard?: { text: string; callback_data?: string }[][]) {
  const message = inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {};
  return {
    chat: { id: 123 },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    callbackQuery: { message },
  } as AnyMock;
}

const athlete = { id: 'athlete-1' } as AnyMock;

beforeEach(() => vi.clearAllMocks());

describe('dispatcher — inbound logging of button taps', () => {
  it('logs a step tap as an inbound message with the recovered label', async () => {
    const ctx = makeCtx([[{ text: 'Beginner', callback_data: 'exp:beginner' }]]);

    await handleOnboardingCallback(ctx, athlete, 'exp:beginner');

    expect(insertSpy).toHaveBeenCalledWith({
      athlete_id: 'athlete-1',
      channel: 'tg',
      direction: 'in',
      body: 'Beginner',
    });
  });

  it('logs a ← Back tap with its label off the keyboard', async () => {
    const ctx = makeCtx([[{ text: '← Back', callback_data: BACK_DATA }]]);

    await handleOnboardingCallback(ctx, athlete, BACK_DATA);

    expect(insertSpy).toHaveBeenCalledWith({
      athlete_id: 'athlete-1',
      channel: 'tg',
      direction: 'in',
      body: '← Back',
    });
  });

  it('falls back to the raw callback data when no label is resolvable', async () => {
    const ctx = makeCtx(); // message has no inline keyboard

    await handleOnboardingCallback(ctx, athlete, 'exp:beginner');

    expect(insertSpy).toHaveBeenCalledWith({
      athlete_id: 'athlete-1',
      channel: 'tg',
      direction: 'in',
      body: 'exp:beginner',
    });
  });
});
