import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InlineKeyboard } from 'grammy';
import { BACK_DATA } from '../back';

// A one-step onboarding whose step implements handleBack. Exercises the
// dispatcher's reserved "← Back" interception: it must route to handleBack (not
// handleCallback), strip the tapped keyboard, advance, and send the prior screen.
const { stepA, sendMessage } = vi.hoisted(() => ({
  stepA: {
    id: 'a',
    questions: [],
    onComplete: vi.fn().mockResolvedValue(undefined),
    handleCallback: vi.fn().mockResolvedValue({ done: false, newPartial: {} }),
    handleBack: vi.fn(),
  },
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../index', () => ({ onboardingSteps: [stepA] }));
vi.mock('../state', () => ({
  loadOnboardingState: vi
    .fn()
    .mockResolvedValue({ step: 0, question: 0, partial: { sub_step: 'capture_part' } }),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

function makeCtx() {
  return {
    chat: { id: 123 },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    callbackQuery: { message: {} },
  } as AnyMock;
}

const athlete = { id: 'athlete-1' } as AnyMock;

beforeEach(() => vi.clearAllMocks());

describe('dispatcher — onb:back interception', () => {
  it('routes onb:back to handleBack, strips the keyboard, advances, and sends the prior screen', async () => {
    const kb = new InlineKeyboard().text('All good', 'injury:none');
    (stepA.handleBack as AnyMock).mockResolvedValue({
      done: false,
      newPartial: { sub_step: 'asking' },
      reply: 'Anything hurting or nagging right now?',
      replyMarkup: kb,
    });
    const ctx = makeCtx();

    await handleOnboardingCallback(ctx, athlete, BACK_DATA);

    expect(stepA.handleBack).toHaveBeenCalledWith({ sub_step: 'capture_part' }, 'athlete-1');
    // Keyboard stripped (no markup arg), NOT collapsed to a "✅ ← Back" record.
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith();
    expect(advanceQuestion).toHaveBeenCalledWith('athlete-1', {
      step: 0,
      question: 0,
      partial: { sub_step: 'asking' },
    });
    expect(sendAndLog as AnyMock).toHaveBeenCalledWith(
      'athlete-1',
      123,
      'Anything hurting or nagging right now?',
      kb,
    );
    // A back tap must never reach the step's forward handler.
    expect(stepA.handleCallback).not.toHaveBeenCalled();
  });
});
