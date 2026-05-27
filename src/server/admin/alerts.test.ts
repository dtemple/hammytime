import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/telegram/bot', () => ({
  telegramBot: vi.fn(),
}));

import { telegramBot } from '@/server/telegram/bot';
import { sendDavidAlert } from './alerts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sendDavidAlert', () => {
  it('sends message to DAVID_TELEGRAM_CHAT_ID when set', async () => {
    const originalEnv = process.env.DAVID_TELEGRAM_CHAT_ID;
    process.env.DAVID_TELEGRAM_CHAT_ID = '12345';

    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    (telegramBot as AnyMock).mockReturnValue({
      api: { sendMessage: sendMessageMock },
    });

    await sendDavidAlert('Test alert message');

    expect(sendMessageMock).toHaveBeenCalledWith('12345', 'Test alert message');

    process.env.DAVID_TELEGRAM_CHAT_ID = originalEnv;
  });

  it('logs a warning and does not throw when DAVID_TELEGRAM_CHAT_ID is not set', async () => {
    const originalEnv = process.env.DAVID_TELEGRAM_CHAT_ID;
    delete process.env.DAVID_TELEGRAM_CHAT_ID;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(sendDavidAlert('Test alert')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DAVID_TELEGRAM_CHAT_ID not set'));
    expect(telegramBot).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    process.env.DAVID_TELEGRAM_CHAT_ID = originalEnv;
  });
});
