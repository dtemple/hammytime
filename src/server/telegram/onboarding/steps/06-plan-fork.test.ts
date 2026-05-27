import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/agent/byo-plan', () => ({
  handleBuildPath: vi.fn().mockResolvedValue(undefined),
  handleHelpPath: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));

import { handleBuildPath, handleHelpPath } from '@/server/agent/byo-plan';
import { supabaseAdmin } from '@/lib/db';
import { planForkStep } from './06-plan-fork';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'athlete-123';

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

/** Returns a db mock where no plans exist for the athlete. */
function makeDbNoPlan() {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'plans') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          }),
        };
      }
      return {};
    }),
  };
}

/** Returns a db mock where a plan exists with the given plan_versions status (or null = no version). */
function makeDbWithPlan(versionStatus: string | null) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'plans') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'plan-1' }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'plan_versions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: versionStatus ? { id: 'version-1' } : null,
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
// Fork conditional (plan already loaded)
// ---------------------------------------------------------------------------

describe('planForkStep.handleMessage — fork conditional', () => {
  const handle = planForkStep.handleMessage!;

  it("short-circuits with 'already loaded' reply when plan_versions status is active", async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDbWithPlan('active'));

    const result = await handle('build', {}, ATHLETE_ID);

    expect(result.done).toBe(true);
    expect(result.reply).toBe('Your plan is already loaded — moving on.');
    expect(handleBuildPath).not.toHaveBeenCalled();
    expect(handleHelpPath).not.toHaveBeenCalled();
  });

  it('short-circuits when plan_versions status is awaiting_paste', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDbWithPlan('awaiting_paste'));

    const result = await handle('help', {}, ATHLETE_ID);

    expect(result.done).toBe(true);
    expect(result.reply).toBe('Your plan is already loaded — moving on.');
    expect(handleBuildPath).not.toHaveBeenCalled();
    expect(handleHelpPath).not.toHaveBeenCalled();
  });

  it('runs the normal fork when no plan_versions exist', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDbNoPlan());

    const result = await handle('build', {}, ATHLETE_ID);

    expect(handleBuildPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
    expect(result.reply).toBeUndefined();
  });

  it('runs the normal fork when a plan exists but no matching version status', async () => {
    // Plan exists but plan_versions has no active/awaiting_paste row
    (supabaseAdmin as AnyMock).mockReturnValue(makeDbWithPlan(null));

    const result = await handle('build', {}, ATHLETE_ID);

    expect(handleBuildPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Normal fork routing (no existing plan)
// ---------------------------------------------------------------------------

describe('planForkStep.handleMessage — fork routing', () => {
  const handle = planForkStep.handleMessage!;

  beforeEach(() => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDbNoPlan());
  });

  it("routes 'build' to handleBuildPath and returns done=true", async () => {
    const result = await handle('build', {}, ATHLETE_ID);
    expect(handleBuildPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
    if (result.done) {
      expect((result.newPartial as AnyMock).chosen).toBe('build');
    }
  });

  it("routes 'b' (shorthand) to handleBuildPath", async () => {
    const result = await handle('b', {}, ATHLETE_ID);
    expect(handleBuildPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
  });

  it("routes 'BUILD' (case-insensitive) to handleBuildPath", async () => {
    const result = await handle('BUILD', {}, ATHLETE_ID);
    expect(handleBuildPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
  });

  it("routes 'help' to handleHelpPath and returns done=true", async () => {
    const result = await handle('help', {}, ATHLETE_ID);
    expect(handleHelpPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
    if (result.done) {
      expect((result.newPartial as AnyMock).chosen).toBe('help');
    }
  });

  it("routes 'h' (shorthand) to handleHelpPath", async () => {
    const result = await handle('h', {}, ATHLETE_ID);
    expect(handleHelpPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
  });

  it('re-asks on unknown input', async () => {
    const result = await handle('upload', {}, ATHLETE_ID);
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.reply).toMatch(/Pick one/);
    }
    expect(handleBuildPath).not.toHaveBeenCalled();
    expect(handleHelpPath).not.toHaveBeenCalled();
  });

  it('handles empty partial (first message after initialPrompt)', async () => {
    const result = await handle('build', {}, ATHLETE_ID);
    expect(result.done).toBe(true);
  });

  it('handles choosing_path sub_step explicitly set', async () => {
    const result = await handle('help', { sub_step: 'choosing_path' }, ATHLETE_ID);
    expect(handleHelpPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
  });
});
