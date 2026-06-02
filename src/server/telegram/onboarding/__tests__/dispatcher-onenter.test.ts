import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InlineKeyboard } from 'grammy';

// A two-step onboarding: step A completes on a callback, step B has an onEnter
// that renders its own opening message. Exercises the dispatcher's dynamic-entry
// wiring (B1 plan preview) without the real steps. vi.hoisted lets the mock
// factories (hoisted to the top of the file) reference these shared spies.
const { stepA, stepB, sendMessage } = vi.hoisted(() => ({
  stepA: {
    id: 'a',
    questions: [],
    onComplete: vi.fn().mockResolvedValue(undefined),
    handleCallback: vi.fn().mockResolvedValue({ done: true, newPartial: {} }),
  },
  stepB: {
    id: 'b',
    questions: [],
    onComplete: vi.fn().mockResolvedValue(undefined),
    onEnter: vi.fn(),
  },
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../index', () => ({ onboardingSteps: [stepA, stepB] }));
vi.mock('../state', () => ({
  loadOnboardingState: vi.fn().mockResolvedValue({ step: 0, question: 0, partial: {} }),
  advanceQuestion: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../bot', () => ({
  sendAndLog: vi.fn().mockResolvedValue(undefined),
  telegramBot: () => ({ api: { sendMessage } }),
}));
vi.mock('@/server/admin/alerts', () => ({ sendDavidAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => ({ from: () => ({ insert: vi.fn().mockResolvedValue({ error: null }) }) }),
}));

import { handleOnboardingCallback } from '../dispatcher';
import { advanceQuestion } from '../state';
import { sendAndLog } from '../../bot';
import { sendDavidAlert } from '@/server/admin/alerts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

function makeCtx() {
  return {
    chat: { id: 123 },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
  } as AnyMock;
}

const athlete = { id: 'athlete-1' } as AnyMock;

beforeEach(() => vi.clearAllMocks());

describe('dispatcher onEnter entry', () => {
  it('calls onEnter on entry and sends its text + keyboard, advancing to the step', async () => {
    const kb = new InlineKeyboard().text('Looks good', 'plan:good');
    stepB.onEnter.mockResolvedValue({ text: "Here's your starting plan…", keyboard: kb });

    await handleOnboardingCallback(makeCtx(), athlete, 'a:done');

    expect(stepB.onEnter).toHaveBeenCalledWith('athlete-1');
    expect(advanceQuestion).toHaveBeenCalledWith('athlete-1', {
      step: 1,
      question: 0,
      partial: {},
    });
    expect(sendMessage).toHaveBeenCalledWith(123, "Here's your starting plan…", {
      reply_markup: kb,
    });
  });

  it('on onEnter throw, sends a fallback and alerts David (does not crash)', async () => {
    stepB.onEnter.mockRejectedValue(new Error('boom'));

    await handleOnboardingCallback(makeCtx(), athlete, 'a:done');

    // Advanced to step B so a later tap still routes there.
    expect(advanceQuestion).toHaveBeenCalledWith('athlete-1', {
      step: 1,
      question: 0,
      partial: {},
    });
    expect(sendAndLog as AnyMock).toHaveBeenCalledWith(
      'athlete-1',
      123,
      expect.stringContaining('putting your plan together'),
    );
    expect(sendDavidAlert as AnyMock).toHaveBeenCalled();
  });
});
