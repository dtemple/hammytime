import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK query() — we script the message stream per test.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../folder', () => ({
  hydrate: vi.fn(),
  syncBack: vi.fn().mockResolvedValue(undefined),
  cleanup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../send', () => ({
  sendReply: vi.fn().mockResolvedValue(undefined),
  startTyping: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock('../persist', () => ({ persistRun: vi.fn().mockResolvedValue('run-1') }));
vi.mock('../plan-version', () => ({ persistPlanEdit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../system-prompt', () => ({
  renderSystemPrompt: vi.fn().mockResolvedValue('SYSTEM PROMPT'),
  buildPrompt: vi.fn().mockReturnValue('PROMPT'),
  loadRecentHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));

import { runAgent } from '../run-agent';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { hydrate, syncBack, cleanup } from '../folder';
import { sendReply } from '../send';
import { persistRun } from '../persist';
import { persistPlanEdit } from '../plan-version';
import { buildPrompt } from '../system-prompt';
import { supabaseAdmin } from '@/lib/db';
import { ALLOWED_TOOLS } from '../isolation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DIR = '/tmp/athletes/' + ATHLETE;

async function* stream(messages: unknown[]) {
  for (const m of messages) yield m;
}

function assistantText(text: string) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}
function assistantToolUse(name: string, input: unknown) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } };
}
function userToolResult(content: unknown) {
  return { type: 'user', message: { content: [{ type: 'tool_result', content }] } };
}
function successResult(text: string) {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
    total_cost_usd: 0.04,
    usage: { input_tokens: 1200, output_tokens: 300 },
  };
}
// SDKResultError has no `result` field — the budget stop carries no clean text.
function budgetResult() {
  return {
    type: 'result',
    subtype: 'error_max_budget_usd',
    total_cost_usd: 1.0,
    usage: { input_tokens: 5000, output_tokens: 2000 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (hydrate as AnyMock).mockResolvedValue({ dir: DIR, memoryHashes: {} });
  (supabaseAdmin as AnyMock).mockImplementation(() => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => ({ data: { timezone: 'America/Los_Angeles' } }) }) }),
    }),
  }));
});

describe('runAgent — happy path', () => {
  beforeEach(() => {
    (query as AnyMock).mockReturnValue(
      stream([
        assistantToolUse('Read', { file_path: `${DIR}/strava_recent.json` }),
        userToolResult('{...}'),
        assistantText('partial'),
        successResult("Easy 5 today — you already ran this morning, so just stretch."),
      ]),
    );
  });

  it('runs the agent confined to the athlete folder with only built-in tools', async () => {
    await runAgent(ATHLETE, 'daily_checkin');
    const opts = (query as AnyMock).mock.calls[0][0].options;
    expect(opts.cwd).toBe(DIR);
    expect(opts.allowedTools).toEqual([...ALLOWED_TOOLS]);
    expect(opts.settingSources).toEqual([]);
    expect(typeof opts.canUseTool).toBe('function');
  });

  it('persists an allowed kind with non-zero tokens and one step per tool call', async () => {
    await runAgent(ATHLETE, 'daily_checkin');
    const args = (persistRun as AnyMock).mock.calls[0][0];
    expect(args.kind).toBe('daily'); // daily_checkin -> 'daily' (allowed CHECK value)
    expect(args.result.usage.input_tokens).toBe(1200);
    // one tool_use + one tool_result captured
    expect(args.steps).toHaveLength(2);
    expect(args.steps[0]).toMatchObject({ kind: 'tool_use', tool_name: 'Read' });
    expect(args.steps[1]).toMatchObject({ kind: 'tool_result' });
  });

  it('maps tg_message to the adhoc kind', async () => {
    await runAgent(ATHLETE, 'tg_message', 'how did I do?');
    expect((persistRun as AnyMock).mock.calls[0][0].kind).toBe('adhoc');
  });

  it('maps post_activity to the adhoc kind and passes the activity id to buildPrompt', async () => {
    await runAgent(ATHLETE, 'post_activity', undefined, 1360128428);
    expect((persistRun as AnyMock).mock.calls[0][0].kind).toBe('adhoc');
    // buildPrompt(source, tz, message, history, activityId)
    expect((buildPrompt as AnyMock).mock.calls[0]).toEqual([
      'post_activity',
      'America/Los_Angeles',
      undefined,
      [],
      1360128428,
    ]);
  });

  it('syncs back, sends the result text, and cleans up', async () => {
    await runAgent(ATHLETE, 'daily_checkin');
    expect(syncBack).toHaveBeenCalledOnce();
    expect(sendReply).toHaveBeenCalledWith(
      ATHLETE,
      'Easy 5 today — you already ran this morning, so just stretch.',
      'run-1',
    );
    expect(cleanup).toHaveBeenCalledWith(DIR);
  });
});

describe('runAgent — SDK failure', () => {
  beforeEach(() => {
    (query as AnyMock).mockImplementation(() => {
      throw new Error('binary spawn failed');
    });
  });

  it('records the run with the error, skips syncBack, sends the soft fallback, still cleans up', async () => {
    await runAgent(ATHLETE, 'daily_checkin');

    expect(syncBack).not.toHaveBeenCalled();
    const args = (persistRun as AnyMock).mock.calls[0][0];
    expect(args.error).toMatch(/binary spawn failed/);

    const sent = (sendReply as AnyMock).mock.calls[0];
    expect(sent[1]).toMatch(/Hit a snag/);
    expect(cleanup).toHaveBeenCalledWith(DIR);
  });
});

describe('runAgent — budget stop is non-destructive', () => {
  beforeEach(() => {
    (query as AnyMock).mockReturnValue(stream([assistantText('partial'), budgetResult()]));
  });

  it('persists file edits and the plan edit even though the run errored on budget', async () => {
    await runAgent(ATHLETE, 'daily_checkin');
    expect(syncBack).toHaveBeenCalledOnce();
    expect(persistPlanEdit).toHaveBeenCalledOnce();
  });

  it('sends the soft fallback, not the partial streamed text', async () => {
    await runAgent(ATHLETE, 'daily_checkin');
    const sent = (sendReply as AnyMock).mock.calls[0];
    expect(sent[1]).toMatch(/Hit a snag/);
    expect(sent[1]).not.toBe('partial');
  });

  it('records the budget-stop subtype as the run error', async () => {
    await runAgent(ATHLETE, 'daily_checkin');
    expect((persistRun as AnyMock).mock.calls[0][0].error).toMatch(/error_max_budget_usd/);
  });
});

describe('runAgent — false-success hole', () => {
  it('never ships text streamed before a mid-stream throw', async () => {
    // Text streams, then the iterator throws — runError is set but replyText holds 'partial'.
    (query as AnyMock).mockReturnValue(
      (async function* () {
        yield assistantText('partial');
        throw new Error('stream died mid-run');
      })(),
    );

    await runAgent(ATHLETE, 'tg_message', 'how did I do?');

    expect(syncBack).not.toHaveBeenCalled(); // a crash still skips persistence
    const sent = (sendReply as AnyMock).mock.calls[0];
    expect(sent[1]).toMatch(/Hit a snag/);
    expect(sent[1]).not.toBe('partial');
  });
});
