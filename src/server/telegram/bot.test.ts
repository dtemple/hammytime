import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('./onboarding/index', () => ({
  handleOnboardingMessage: vi.fn().mockResolvedValue(undefined),
  handleOnboardingCallback: vi.fn().mockResolvedValue(undefined),
  onboardingSteps: new Array(7),
  resetOnboarding: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./checkin/dispatcher', () => ({
  handleCheckinCommand: vi.fn().mockResolvedValue(undefined),
  handleWellnessMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('child_process', () => ({ execSync: vi.fn().mockReturnValue('abc1234 — test commit') }));
vi.mock('grammy', () => ({ Bot: vi.fn(), Context: vi.fn() }));
vi.mock('@/server/jobs/enqueue', () => ({ enqueueJob: vi.fn().mockResolvedValue(undefined) }));

import { supabaseAdmin } from '@/lib/db';
import { Bot } from 'grammy';
import { handleWellnessMessage } from './checkin/dispatcher';
import { enqueueJob } from '@/server/jobs/enqueue';
import { handleInboundText, handleConnectStravaCommand, _resetBotForTest } from './bot';

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
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: versionStatus ? { status: versionStatus } : null,
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Post-onboarding routing — awaiting_paste
// ---------------------------------------------------------------------------

describe('handleInboundText — post-onboarding routing', () => {
  it('replies with setup placeholder when plan_versions status is awaiting_paste', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb('awaiting_paste'));
    const ctx = makeCtx();

    await handleInboundText(ctx as AnyMock);

    expect(ctx.reply).toHaveBeenCalledWith(
      'Your plan is being set up. Daily coaching is coming soon.',
    );
  });

  it('does not include a /p/ URL in the awaiting_paste reply', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb('awaiting_paste'));
    const ctx = makeCtx();

    await handleInboundText(ctx as AnyMock);

    const replyText = (ctx.reply as AnyMock).mock.calls[0]![0] as string;
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

  it('replies with help-path message when no plan row exists', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb(null, false));
    const ctx = makeCtx();

    await handleInboundText(ctx as AnyMock);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("David's on it"));
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
      }),
    });
    const ctx = makeCtx();

    await handleConnectStravaCommand(ctx as AnyMock);

    expect(ctx.reply).toHaveBeenCalledWith('Finish onboarding first.');
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
