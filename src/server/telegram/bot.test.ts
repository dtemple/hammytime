import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('./onboarding/index', () => ({
  handleOnboardingMessage: vi.fn().mockResolvedValue(undefined),
  handleOnboardingCallback: vi.fn().mockResolvedValue(undefined),
  onboardingSteps: new Array(7),
  isOnboarded: (ob: { flow?: string; phase?: string; step?: number } | null) =>
    ob?.flow === 'v3' ? ob.phase === 'complete' : (typeof ob?.step === 'number' ? ob.step : 0) >= 7,
  hardResetOnboarding: vi.fn().mockResolvedValue(undefined),
  // Mirror the real label recovery: match the tapped button by callback_data.
  labelForTap: vi.fn(
    (
      rows: { text: string; callback_data?: string }[][] | undefined,
      data: string,
    ): string | null =>
      rows?.flat().find((b) => b.callback_data === data)?.text ?? null,
  ),
}));
vi.mock('./checkin/dispatcher', () => ({
  handleCheckinCommand: vi.fn().mockResolvedValue(undefined),
  handleWellnessMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('child_process', () => ({ execSync: vi.fn().mockReturnValue('abc1234 — test commit') }));
vi.mock('grammy', () => ({
  Bot: vi.fn(),
  Context: vi.fn(),
  // Mirrors grammy's row-building: url/text append to the current row, row()
  // starts a new one.
  InlineKeyboard: class {
    inline_keyboard: { text: string; url?: string; callback_data?: string }[][] = [[]];
    url(text: string, url: string) {
      this.inline_keyboard[this.inline_keyboard.length - 1]!.push({ text, url });
      return this;
    }
    text(text: string, callback_data: string) {
      this.inline_keyboard[this.inline_keyboard.length - 1]!.push({ text, callback_data });
      return this;
    }
    row() {
      this.inline_keyboard.push([]);
      return this;
    }
  },
}));
vi.mock('@/server/jobs/enqueue', () => ({ enqueueJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/server/strava/disconnect', () => ({ disconnectStrava: vi.fn() }));
vi.mock('@/server/google/disconnect', () => ({ disconnectGoogleCalendar: vi.fn() }));
vi.mock('@/server/google/enqueue-sync', () => ({
  enqueueCalendarSyncIfConnected: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/calendar-token', () => ({
  getOrCreateCalendarToken: vi
    .fn()
    .mockResolvedValue({ token: 'cal-tok', url: 'https://daybreak.run/api/calendar/cal-tok.ics' }),
  getOrCreatePrehabToken: vi
    .fn()
    .mockResolvedValue({ token: 'pre-tok', url: 'https://daybreak.run/prehab/pre-tok' }),
}));

import { supabaseAdmin } from '@/lib/db';
import { Bot, InlineKeyboard } from 'grammy';
import { handleWellnessMessage } from './checkin/dispatcher';
import { enqueueJob } from '@/server/jobs/enqueue';
import { disconnectStrava } from '@/server/strava/disconnect';
import { disconnectGoogleCalendar } from '@/server/google/disconnect';
import { enqueueCalendarSyncIfConnected } from '@/server/google/enqueue-sync';
import {
  sendAndLog,
  handleInboundText,
  handleInboundVoice,
  handleInboundMedia,
  handleConnectStravaCommand,
  handlePrehabCommand,
  handleDisconnectStravaCommand,
  handleDisconnectCalendarCommand,
  handleNextAction,
  handleCalendarConfirm,
  handleCalendarPick,
  _resetBotForTest,
} from './bot';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'athlete-1';
const CHAT_ID = 999;

// Minimal grammy Context mock
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    chat: { id: CHAT_ID },
    reply: vi.fn().mockResolvedValue(undefined),
    message: { text: 'hi' },
    ...overrides,
  };
}

// Builds a db mock that returns a post-onboarding athlete with a given plan_versions status
function makeDb(
  versionStatus: string | null,
  hasPlan = true,
  checkinState: Record<string, unknown> = {},
) {
  const athlete = {
    id: ATHLETE_ID,
    telegram_chat_id: String(CHAT_ID),
    onboarding_state: { step: 7 }, // terminal — past all onboarding steps
    checkin_state: checkinState,
  };

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'athletes') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: athlete, error: null }),
            }),
          }),
        };
      }
      if (table === 'messages') {
        return { insert: vi.fn().mockResolvedValue({ error: null }) };
      }
      if (table === 'plans') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: hasPlan ? { id: 'plan-1' } : null,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'plan_versions') {
        // Honor the .in('status', [...]) filter the router applies: a row is
        // only visible if its status is one of the requested live statuses.
        // This is what makes a dangling `proposed` version invisible to the
        // inbound path instead of shadowing the active plan.
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockImplementation((_col: string, statuses: string[]) => ({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data:
                        versionStatus && statuses.includes(versionStatus)
                          ? { status: versionStatus }
                          : null,
                      error: null,
                    }),
                  }),
                }),
              })),
            }),
          }),
        };
      }
      return {};
    }),
  };
}

// Configure the grammy Bot mock + token so getBot()/sendAndLog can actually send,
// and return the sendMessage spy for assertions. Used by tests whose path now goes
// through sendAndLog (athlete-facing replies are logged, not bare ctx.reply).
function configureBotSend() {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  const sendMessageMock = vi.fn().mockResolvedValue(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Bot as AnyMock).mockImplementation(function (this: any) {
    return { api: { sendMessage: sendMessageMock }, command: vi.fn(), on: vi.fn(), catch: vi.fn() };
  });
  _resetBotForTest();
  return sendMessageMock;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// sendAndLog — chip/button logging
// ---------------------------------------------------------------------------

describe('sendAndLog — keyboard logging', () => {
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('renders button labels into the logged body but sends clean text', async () => {
    const send = configureBotSend();
    const inserts: Array<{ body: string }> = [];
    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockImplementation((row: { body: string }) => {
          inserts.push(row);
          return Promise.resolve({ error: null });
        }),
      }),
    });
    // One button per row, matching the onboarding chip layout.
    const kb = new InlineKeyboard().text('Race', 'v3:race').row().text('5k', 'v3:5k');

    await sendAndLog(ATHLETE_ID, CHAT_ID, 'What are you training for?', kb);

    // Telegram gets the clean text + the real tappable keyboard.
    expect(send).toHaveBeenCalledWith(CHAT_ID, 'What are you training for?', {
      reply_markup: kb,
    });
    // The log carries the options (for the transcript + the model's history).
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.body).toBe('What are you training for?\n\n[ Race ]\n[ 5k ]');
  });

  it('logs the bare text when there is no keyboard', async () => {
    const send = configureBotSend();
    const inserts: Array<{ body: string }> = [];
    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockImplementation((row: { body: string }) => {
          inserts.push(row);
          return Promise.resolve({ error: null });
        }),
      }),
    });

    await sendAndLog(ATHLETE_ID, CHAT_ID, 'On it.');

    expect(send).toHaveBeenCalledWith(CHAT_ID, 'On it.');
    expect(inserts[0]!.body).toBe('On it.');
  });
});

// ---------------------------------------------------------------------------
// Post-onboarding routing — awaiting_paste
// ---------------------------------------------------------------------------

describe('handleInboundText — post-onboarding routing', () => {
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('replies with setup placeholder when plan_versions status is awaiting_paste', async () => {
    const send = configureBotSend();
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb('awaiting_paste'));
    const ctx = makeCtx();

    await handleInboundText(ctx as AnyMock);

    expect(send).toHaveBeenCalledWith(CHAT_ID, 'Your plan is being set up. Daily updates start soon.');
  });

  it('does not include a /p/ URL in the awaiting_paste reply', async () => {
    const send = configureBotSend();
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb('awaiting_paste'));
    const ctx = makeCtx();

    await handleInboundText(ctx as AnyMock);

    const replyText = (send as AnyMock).mock.calls[0]![1] as string;
    expect(replyText).not.toContain('/p/');
    expect(replyText).not.toContain('http');
  });

  it('enqueues a tg_message job (no inline reply) when plan_versions status is active', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb('active'));
    const ctx = makeCtx({ message: { text: 'how did I do?', message_id: 555 } });

    await handleInboundText(ctx as AnyMock);

    expect(enqueueJob).toHaveBeenCalledWith(
      'tg_message',
      `tg-${ATHLETE_ID}-555`,
      { athlete_id: ATHLETE_ID, text: 'how did I do?' },
    );
    // Worker owns the reply — the bot returns fast without replying inline.
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('ignores a dangling proposed version and routes by the active plan', async () => {
    // Regression: the "Update your calendar?" flow leaves a `proposed` version
    // as the newest plan_versions row. The router must filter to live statuses
    // (active/awaiting_paste) so it reads the active plan and enqueues, rather
    // than reading the proposal and dead-ending the message. We assert the
    // status filter is applied and that a `proposed` row is never enqueued on.
    const inSpy = vi.fn();
    const db = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'athletes') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: ATHLETE_ID,
                    telegram_chat_id: String(CHAT_ID),
                    onboarding_state: { step: 7 },
                    checkin_state: {},
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'messages') return { insert: vi.fn().mockResolvedValue({ error: null }) };
        if (table === 'plans') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'plan-1' }, error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'plan_versions') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockImplementation((col: string, statuses: string[]) => {
                  inSpy(col, statuses);
                  // The proposed row is newest but excluded by the filter; the
                  // active plan is what the live-status query returns.
                  return {
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({
                          data: { status: 'active' },
                          error: null,
                        }),
                      }),
                    }),
                  };
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    const ctx = makeCtx({ message: { text: 'knee stayed quiet', message_id: 777 } });

    await handleInboundText(ctx as AnyMock);

    expect(inSpy).toHaveBeenCalledWith('status', ['active', 'awaiting_paste']);
    expect(enqueueJob).toHaveBeenCalledWith('tg_message', `tg-${ATHLETE_ID}-777`, {
      athlete_id: ATHLETE_ID,
      text: 'knee stayed quiet',
    });
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('replies with help-path message when no plan row exists', async () => {
    const send = configureBotSend();
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb(null, false));
    const ctx = makeCtx();

    await handleInboundText(ctx as AnyMock);

    expect(send).toHaveBeenCalledWith(CHAT_ID, expect.stringContaining("David's on it"));
  });
});

// ---------------------------------------------------------------------------
// Wellness battery routing
// ---------------------------------------------------------------------------

describe('handleInboundText — wellness routing', () => {
  it('routes to handleWellnessMessage when checkin_state.sub_step is set', async () => {
    const activeCheckin = { sub_step: 'awaiting_readiness', partial: {} };
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb('active', true, activeCheckin));
    const ctx = makeCtx();

    await handleInboundText(ctx as AnyMock);

    expect(handleWellnessMessage).toHaveBeenCalledOnce();
    // Should not fall through to plan-status reply
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('does not route to wellness when checkin_state is empty', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb('active', true, {}));
    const ctx = makeCtx();

    await handleInboundText(ctx as AnyMock);

    expect(handleWellnessMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Inbound voice (transcription failure path)
// ---------------------------------------------------------------------------

describe('handleInboundVoice', () => {
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('logs the attempt + fallback when transcription fails', async () => {
    const send = configureBotSend();
    const inserts: Array<{ direction: string; body: string }> = [];
    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'athletes') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: ATHLETE_ID }, error: null }),
              }),
            }),
          };
        }
        if (table === 'messages') {
          return {
            insert: vi.fn().mockImplementation((row: { direction: string; body: string }) => {
              inserts.push(row);
              return Promise.resolve({ error: null });
            }),
          };
        }
        return {};
      }),
    });
    // getFile throwing short-circuits the try block straight to the catch — no
    // need to mock fetch/transcribeOgg to exercise the failure path.
    const ctx = makeCtx({
      react: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockRejectedValue(new Error('telegram getFile down')),
    });

    await handleInboundVoice(ctx as AnyMock);

    // The fallback is sent AND logged; the attempt is recorded as a placeholder
    // inbound so a failed voice note isn't an invisible gap in the transcript.
    expect(send).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('Voice transcription is having trouble'),
    );
    expect(inserts).toContainEqual(expect.objectContaining({ direction: 'in', body: '[voice note]' }));
  });
});

// ---------------------------------------------------------------------------
// Inbound media (photos, files, video, stickers…)
// ---------------------------------------------------------------------------

describe('handleInboundMedia', () => {
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('logs the attempt + notice (no caption) and does not route to coaching', async () => {
    const send = configureBotSend();
    const inserts: Array<{ direction: string; body: string }> = [];
    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'athletes') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: ATHLETE_ID }, error: null }),
              }),
            }),
          };
        }
        if (table === 'messages') {
          return {
            insert: vi.fn().mockImplementation((row: { direction: string; body: string }) => {
              inserts.push(row);
              return Promise.resolve({ error: null });
            }),
          };
        }
        return {};
      }),
    });
    const ctx = makeCtx({ message: { photo: [{ file_id: 'abc' }], message_id: 7 } });

    await handleInboundMedia(ctx as AnyMock);

    // The notice is sent AND logged (not a bare ctx.reply).
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(CHAT_ID, expect.stringContaining("can't open attachments"));
    // The attempt is recorded as a placeholder inbound so the notice isn't orphaned.
    expect(inserts).toContainEqual(expect.objectContaining({ direction: 'in', body: '[attachment]' }));
    // No caption → never routed into the coaching pipeline.
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('posts the notice then routes the caption through handleInboundText as if typed', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb('active'));
    const ctx = makeCtx({
      message: { photo: [{ file_id: 'abc' }], caption: 'how did my long run look?', message_id: 42 },
      react: vi.fn().mockResolvedValue(undefined),
    });

    await handleInboundMedia(ctx as AnyMock);

    // Athlete is told images aren't read yet.
    expect((ctx.reply as AnyMock).mock.calls[0]![0]).toContain("can't open attachments");
    // The caption is dispatched as a normal message: enqueued for the worker.
    expect(enqueueJob).toHaveBeenCalledWith(
      'tg_message',
      `tg-${ATHLETE_ID}-42`,
      { athlete_id: ATHLETE_ID, text: 'how did my long run look?' },
    );
    // It was injected onto ctx.message.text so downstream paths read it.
    expect((ctx.message as { text?: string }).text).toBe('how did my long run look?');
  });

  it('reacts once per album, dropping the repeat items of the same media group', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb('active'));
    const mediaGroupId = 'album-abc';
    // Telegram puts the caption on the first item only; the rest share the group id.
    const first = makeCtx({
      message: {
        photo: [{ file_id: 'a' }],
        caption: 'check these out',
        media_group_id: mediaGroupId,
        message_id: 1,
      },
      react: vi.fn().mockResolvedValue(undefined),
    });
    const second = makeCtx({
      message: { photo: [{ file_id: 'b' }], media_group_id: mediaGroupId, message_id: 2 },
    });

    await handleInboundMedia(first as AnyMock);
    await handleInboundMedia(second as AnyMock);

    // First item handled: one notice, caption routed once.
    expect(first.reply).toHaveBeenCalledOnce();
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    // Repeat item suppressed entirely — no second notice.
    expect(second.reply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// /connect_strava command
// ---------------------------------------------------------------------------

describe('/connect_strava command', () => {
  beforeEach(() => {
    _resetBotForTest();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it('replies with invite-link message when athlete is not found', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    });
    const ctx = makeCtx();

    await handleConnectStravaCommand(ctx as AnyMock);

    expect(ctx.reply).toHaveBeenCalledWith('Use your invite link to get started.');
  });

  it("replies with 'Finish onboarding first' when onboarding is incomplete", async () => {
    const send = configureBotSend();
    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: ATHLETE_ID,
                telegram_chat_id: String(CHAT_ID),
                onboarding_state: { step: 3 }, // < 7 → incomplete
              },
              error: null,
            }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      }),
    });
    const ctx = makeCtx();

    await handleConnectStravaCommand(ctx as AnyMock);

    expect(send).toHaveBeenCalledWith(CHAT_ID, 'Finish onboarding first.');
  });

  it('sends URL reply containing /strava/connect?athlete_id= for completed athlete', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.NEXT_PUBLIC_APP_URL = 'https://hammytime.example.com';

    // Configure grammy Bot mock so `new Bot(token)` returns a usable instance.
    // Must use a regular function (not arrow) since arrow functions can't be constructors.
    // Returning an object from a constructor causes `new` to yield that object.
    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Bot as AnyMock).mockImplementation(function (this: any) {
      return {
        api: { sendMessage: sendMessageMock },
        command: vi.fn(),
        on: vi.fn(),
        catch: vi.fn(),
      };
    });

    // Track messages inserts so we can verify the outbound message body
    const messagesInserts: unknown[] = [];
    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'athletes') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: ATHLETE_ID,
                    telegram_chat_id: String(CHAT_ID),
                    onboarding_state: { step: 7 }, // complete
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'messages') {
          return {
            insert: vi.fn().mockImplementation((row: unknown) => {
              messagesInserts.push(row);
              return Promise.resolve({ error: null });
            }),
          };
        }
        return {};
      }),
    });

    const ctx = makeCtx();

    await handleConnectStravaCommand(ctx as AnyMock);

    // No refusal reply
    expect(ctx.reply).not.toHaveBeenCalled();

    // Telegram message sent via Bot.api.sendMessage
    expect(sendMessageMock).toHaveBeenCalledOnce();
    const [, sentText] = (sendMessageMock as AnyMock).mock.calls[0] as [unknown, string];
    expect(sentText).toContain(`/strava/connect?athlete_id=${ATHLETE_ID}`);
    expect(sentText).toContain('https://hammytime.example.com');

    // Outbound logged to messages table
    const outbound = (messagesInserts as Array<{ direction: string; body: string }>).find(
      (r) => r.direction === 'out',
    );
    expect(outbound).toBeDefined();
    expect(outbound!.body).toContain(`/strava/connect?athlete_id=${ATHLETE_ID}`);
  });
});

// ---------------------------------------------------------------------------
// /disconnect_strava command
// ---------------------------------------------------------------------------

describe('/prehab command', () => {
  beforeEach(() => {
    _resetBotForTest();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('replies with invite-link message when athlete is not found', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    });
    const ctx = makeCtx();

    await handlePrehabCommand(ctx as AnyMock);

    expect(ctx.reply).toHaveBeenCalledWith('Use your invite link to get started.');
  });

  it("replies with 'Finish onboarding first' when onboarding is incomplete", async () => {
    const send = configureBotSend();
    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: ATHLETE_ID,
                telegram_chat_id: String(CHAT_ID),
                onboarding_state: { step: 3 },
              },
              error: null,
            }),
          }),
        }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      }),
    });
    const ctx = makeCtx();

    await handlePrehabCommand(ctx as AnyMock);

    expect(send).toHaveBeenCalledWith(CHAT_ID, 'Finish onboarding first.');
  });

  it('logs the inbound command and sends the prehab routine URL', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Bot as AnyMock).mockImplementation(function (this: any) {
      return {
        api: { sendMessage: sendMessageMock },
        command: vi.fn(),
        on: vi.fn(),
        catch: vi.fn(),
      };
    });

    const messagesInserts: { direction: string; body: string }[] = [];
    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'athletes') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: ATHLETE_ID,
                    telegram_chat_id: String(CHAT_ID),
                    onboarding_state: { step: 7 },
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'messages') {
          return {
            insert: vi.fn().mockImplementation((row: { direction: string; body: string }) => {
              messagesInserts.push(row);
              return Promise.resolve({ error: null });
            }),
          };
        }
        return {};
      }),
    });

    const ctx = makeCtx();

    await handlePrehabCommand(ctx as AnyMock);

    expect(ctx.reply).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith(
      String(CHAT_ID),
      'Your prehab routine: https://daybreak.run/prehab/pre-tok',
    );
    expect(messagesInserts.map((m) => m.direction)).toEqual(['in', 'out']);
    expect(messagesInserts[0]!.body).toBe('/prehab');
  });
});

describe('/disconnect_strava command', () => {
  beforeEach(() => {
    _resetBotForTest();
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  // Wires the grammy Bot mock and returns the captured outbound messages + the
  // sendMessage spy. db returns the athlete row, swallows messages inserts.
  function setup(athleteRow: object | null) {
    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Bot as AnyMock).mockImplementation(function (this: any) {
      return {
        api: { sendMessage: sendMessageMock },
        command: vi.fn(),
        on: vi.fn(),
        catch: vi.fn(),
      };
    });

    const messagesInserts: Array<{ direction: string; body: string }> = [];
    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'athletes') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: athleteRow, error: null }),
              }),
            }),
          };
        }
        if (table === 'messages') {
          return {
            insert: vi.fn().mockImplementation((row: { direction: string; body: string }) => {
              messagesInserts.push(row);
              return Promise.resolve({ error: null });
            }),
          };
        }
        return {};
      }),
    });

    return { sendMessageMock, messagesInserts };
  }

  it('replies with no-record message when athlete is not found', async () => {
    setup(null);
    const ctx = makeCtx();

    await handleDisconnectStravaCommand(ctx as AnyMock);

    expect(ctx.reply).toHaveBeenCalledWith('No athlete record found for this chat.');
    expect(disconnectStrava).not.toHaveBeenCalled();
  });

  it('disconnects, revokes, and confirms when a connection exists', async () => {
    const { sendMessageMock } = setup({ id: ATHLETE_ID });
    (disconnectStrava as AnyMock).mockResolvedValue({ hadConnection: true, revoked: true });
    const ctx = makeCtx();

    await handleDisconnectStravaCommand(ctx as AnyMock);

    expect(disconnectStrava).toHaveBeenCalledWith(ATHLETE_ID, { revokeOnStrava: true });
    expect(sendMessageMock).toHaveBeenCalledOnce();
    const [, sentText] = (sendMessageMock as AnyMock).mock.calls[0] as [unknown, string];
    expect(sentText).toContain('Disconnected from Strava');
  });

  it('tells the athlete when there is no connection on file', async () => {
    const { sendMessageMock } = setup({ id: ATHLETE_ID });
    (disconnectStrava as AnyMock).mockResolvedValue({ hadConnection: false, revoked: false });
    const ctx = makeCtx();

    await handleDisconnectStravaCommand(ctx as AnyMock);

    expect(disconnectStrava).toHaveBeenCalledWith(ATHLETE_ID, { revokeOnStrava: true });
    const [, sentText] = (sendMessageMock as AnyMock).mock.calls[0] as [unknown, string];
    expect(sentText).toContain("don't have a Strava connection");
  });
});

describe('/disconnect_calendar command', () => {
  beforeEach(() => {
    _resetBotForTest();
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  function setup(athleteRow: object | null) {
    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Bot as AnyMock).mockImplementation(function (this: any) {
      return {
        api: { sendMessage: sendMessageMock },
        command: vi.fn(),
        on: vi.fn(),
        catch: vi.fn(),
      };
    });

    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'athletes') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: athleteRow, error: null }),
              }),
            }),
          };
        }
        if (table === 'messages') {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        return {};
      }),
    });

    return { sendMessageMock };
  }

  it('replies with no-record message when athlete is not found', async () => {
    setup(null);
    const ctx = makeCtx();

    await handleDisconnectCalendarCommand(ctx as AnyMock);

    expect(ctx.reply).toHaveBeenCalledWith('No athlete record found for this chat.');
    expect(disconnectGoogleCalendar).not.toHaveBeenCalled();
  });

  it('disconnects, removes the calendar, and confirms', async () => {
    const { sendMessageMock } = setup({ id: ATHLETE_ID });
    (disconnectGoogleCalendar as AnyMock).mockResolvedValue({
      hadConnection: true,
      calendarDeleted: true,
    });
    const ctx = makeCtx();

    await handleDisconnectCalendarCommand(ctx as AnyMock);

    expect(disconnectGoogleCalendar).toHaveBeenCalledWith(ATHLETE_ID);
    const [, sentText] = (sendMessageMock as AnyMock).mock.calls[0] as [unknown, string];
    expect(sentText).toContain('Disconnected');
    expect(sentText).toContain('gone from your Google account');
  });

  it('notes the leftover calendar when the remote delete could not run', async () => {
    const { sendMessageMock } = setup({ id: ATHLETE_ID });
    (disconnectGoogleCalendar as AnyMock).mockResolvedValue({
      hadConnection: true,
      calendarDeleted: false,
    });
    const ctx = makeCtx();

    await handleDisconnectCalendarCommand(ctx as AnyMock);

    const [, sentText] = (sendMessageMock as AnyMock).mock.calls[0] as [unknown, string];
    expect(sentText).toContain("couldn't remove");
  });

  it('tells the athlete when there is no connection on file', async () => {
    const { sendMessageMock } = setup({ id: ATHLETE_ID });
    (disconnectGoogleCalendar as AnyMock).mockResolvedValue({
      hadConnection: false,
      calendarDeleted: false,
    });
    const ctx = makeCtx();

    await handleDisconnectCalendarCommand(ctx as AnyMock);

    const [, sentText] = (sendMessageMock as AnyMock).mock.calls[0] as [unknown, string];
    expect(sentText).toContain("don't have Google Calendar connected");
  });
});

// ---------------------------------------------------------------------------
// Phase D next-actions — inbound logging (V3-W0)
// ---------------------------------------------------------------------------

describe('handleNextAction — inbound logging', () => {
  beforeEach(() => {
    _resetBotForTest();
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('logs the tapped next-action as an inbound message with its label', async () => {
    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Bot as AnyMock).mockImplementation(function (this: any) {
      return { api: { sendMessage: sendMessageMock }, command: vi.fn(), on: vi.fn(), catch: vi.fn() };
    });

    const messagesInserts: Array<{ direction: string; body: string }> = [];
    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            insert: vi.fn().mockImplementation((row: { direction: string; body: string }) => {
              messagesInserts.push(row);
              return Promise.resolve({ error: null });
            }),
          };
        }
        return {};
      }),
    });

    const ctx = makeCtx({
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      callbackQuery: {
        message: { reply_markup: { inline_keyboard: [[{ text: "That's it for today", callback_data: 'next:done' }]] } },
      },
    });

    await handleNextAction(ctx as AnyMock, { id: ATHLETE_ID } as AnyMock, 'next:done');

    const inbound = messagesInserts.find((r) => r.direction === 'in');
    expect(inbound).toBeDefined();
    expect(inbound!.body).toBe("That's it for today");
  });
});

// ---------------------------------------------------------------------------
// Calendar message — Google connect button vs connected state (CALENDAR_OAUTH)
// ---------------------------------------------------------------------------

describe('calendar message via next:calendar', () => {
  beforeEach(() => {
    _resetBotForTest();
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.NEXT_PUBLIC_APP_URL = 'https://daybreak.run';
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  function setup(googleConnected: boolean) {
    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Bot as AnyMock).mockImplementation(function (this: any) {
      return { api: { sendMessage: sendMessageMock }, command: vi.fn(), on: vi.fn(), catch: vi.fn() };
    });

    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'messages') {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        if (table === 'oauth_tokens') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: googleConnected ? { id: 'tok-1' } : null,
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
    });

    return { sendMessageMock };
  }

  function calCtx() {
    return makeCtx({
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      callbackQuery: {
        message: {
          reply_markup: {
            inline_keyboard: [[{ text: 'Add to calendar', callback_data: 'next:calendar' }]],
          },
        },
      },
    });
  }

  it('asks which calendar with the two-button picker when not connected', async () => {
    const { sendMessageMock } = setup(false);

    await handleNextAction(calCtx() as AnyMock, { id: ATHLETE_ID } as AnyMock, 'next:calendar');

    expect(sendMessageMock).toHaveBeenCalledOnce();
    const [, text, opts] = (sendMessageMock as AnyMock).mock.calls[0];
    expect(text).toBe('Which calendar do you use?');
    // No wall of text — the ICS link arrives only after the athlete picks.
    expect(text).not.toContain('.ics');
    expect(opts.reply_markup.inline_keyboard).toEqual([
      [
        {
          text: 'Google Calendar',
          url: `https://daybreak.run/google/connect?athlete_id=${ATHLETE_ID}`,
        },
      ],
      [{ text: 'Apple Calendar, Outlook, anything else', callback_data: 'calpick:ics' }],
    ]);
  });

  it('shows connected state (no picker) once Google is connected', async () => {
    const { sendMessageMock } = setup(true);

    await handleNextAction(calCtx() as AnyMock, { id: ATHLETE_ID } as AnyMock, 'next:calendar');

    const [, text, opts] = (sendMessageMock as AnyMock).mock.calls[0];
    expect(text).toContain('Google Calendar: connected');
    expect(text).toContain('https://daybreak.run/api/calendar/cal-tok.ics');
    expect(text).toContain('/disconnect_calendar');
    expect(opts).toBeUndefined();
  });

  it('answers the Apple/Outlook/other tap with the subscribe link', async () => {
    const { sendMessageMock } = setup(false);
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      answerCallbackQuery,
      callbackQuery: {
        message: {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Apple Calendar, Outlook, anything else', callback_data: 'calpick:ics' }],
            ],
          },
        },
      },
    });

    await handleCalendarPick(ctx as AnyMock, { id: ATHLETE_ID } as AnyMock, 'calpick:ics');

    expect(answerCallbackQuery).toHaveBeenCalled();
    const [, text, opts] = (sendMessageMock as AnyMock).mock.calls[0];
    expect(text).toContain('https://daybreak.run/api/calendar/cal-tok.ics');
    expect(text).toContain('Apple Calendar — File → New Calendar Subscription');
    expect(text).toContain('Outlook — Add calendar → Subscribe from web');
    expect(opts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Calendar-confirm taps (Specs/CALENDAR_CONFIRM.md)
// ---------------------------------------------------------------------------

describe('handleCalendarConfirm', () => {
  type RpcResult = { data: string | null; error: { message: string } | null };

  function makeCalDb(rpcResult: RpcResult, hasPlan = true) {
    const messagesInserts: Array<{ direction: string; body: string }> = [];
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const db = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            insert: vi.fn().mockImplementation((row: { direction: string; body: string }) => {
              messagesInserts.push(row);
              return Promise.resolve({ error: null });
            }),
          };
        }
        if (table === 'plans') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: hasPlan ? { id: 'plan-1' } : null,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
      rpc: vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        return Promise.resolve(rpcResult);
      }),
    };
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    return { messagesInserts, rpcCalls };
  }

  function makeCalCtx() {
    return {
      chat: { id: CHAT_ID },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      callbackQuery: {
        message: {
          text: 'Update your calendar?',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Yes, update', callback_data: 'cal:y:tok1' },
                { text: 'No, leave it', callback_data: 'cal:n:tok1' },
              ],
            ],
          },
        },
      },
    };
  }

  it('Yes tap promotes the candidate and resolves the message', async () => {
    const { messagesInserts, rpcCalls } = makeCalDb({ data: 'promoted', error: null });
    const ctx = makeCalCtx();

    await handleCalendarConfirm(ctx as AnyMock, { id: ATHLETE_ID } as AnyMock, 'cal:y:tok1');

    expect(rpcCalls).toEqual([
      { name: 'promote_proposed_version', args: { p_plan_id: 'plan-1', p_token: 'tok1' } },
    ]);
    expect(ctx.editMessageText).toHaveBeenCalledWith('Update your calendar?\n\n✓ Calendar updated.');
    expect(messagesInserts.find((r) => r.direction === 'in')?.body).toBe('Yes, update');
    expect(messagesInserts.find((r) => r.direction === 'out')?.body).toBe('✓ Calendar updated.');
    // The promoted version is an active-plan change — the Google calendar
    // sync rides on it (no-op for unconnected athletes).
    expect(enqueueCalendarSyncIfConnected).toHaveBeenCalledWith(ATHLETE_ID, 'promotion');
  });

  it('No tap discards the candidate and resolves the message', async () => {
    const { rpcCalls } = makeCalDb({ data: 'discarded', error: null });
    const ctx = makeCalCtx();

    await handleCalendarConfirm(ctx as AnyMock, { id: ATHLETE_ID } as AnyMock, 'cal:n:tok1');

    expect(rpcCalls).toEqual([
      { name: 'discard_proposed_version', args: { p_plan_id: 'plan-1', p_token: 'tok1' } },
    ]);
    expect(ctx.editMessageText).toHaveBeenCalledWith('Update your calendar?\n\nLeft as-is.');
    expect(enqueueCalendarSyncIfConnected).not.toHaveBeenCalled();
  });

  it.each(['expired', 'stale'])('%s candidate resolves with the expired copy', async (result) => {
    makeCalDb({ data: result, error: null });
    const ctx = makeCalCtx();

    await handleCalendarConfirm(ctx as AnyMock, { id: ATHLETE_ID } as AnyMock, 'cal:y:tok1');

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      'Update your calendar?\n\nThis one expired — ask me again if you still want the change.',
    );
    expect(enqueueCalendarSyncIfConnected).not.toHaveBeenCalled();
  });

  it('not_found (re-tap / webhook retry) resolves quietly without throwing', async () => {
    makeCalDb({ data: 'not_found', error: null });
    const ctx = makeCalCtx();

    await handleCalendarConfirm(ctx as AnyMock, { id: ATHLETE_ID } as AnyMock, 'cal:y:tok1');

    expect(ctx.editMessageText).toHaveBeenCalledWith('Update your calendar?\n\nAlready handled.');
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('RPC error keeps the keyboard alive and surfaces a try-again toast', async () => {
    makeCalDb({ data: null, error: { message: 'db down' } });
    const ctx = makeCalCtx();

    await handleCalendarConfirm(ctx as AnyMock, { id: ATHLETE_ID } as AnyMock, 'cal:y:tok1');

    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Something went wrong — try again in a moment.',
    });
  });

  it('malformed cal: data answers the callback and does nothing else', async () => {
    const { rpcCalls, messagesInserts } = makeCalDb({ data: 'promoted', error: null });
    const ctx = makeCalCtx();

    await handleCalendarConfirm(ctx as AnyMock, { id: ATHLETE_ID } as AnyMock, 'cal:y:');

    expect(rpcCalls).toHaveLength(0);
    expect(messagesInserts).toHaveLength(0);
    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('no plan row answers the callback without calling an RPC', async () => {
    const { rpcCalls } = makeCalDb({ data: 'promoted', error: null }, false);
    const ctx = makeCalCtx();

    await handleCalendarConfirm(ctx as AnyMock, { id: ATHLETE_ID } as AnyMock, 'cal:y:tok1');

    expect(rpcCalls).toHaveLength(0);
    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });
});
