import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('../memory', () => ({ upsertMemorySection: vi.fn(), upsertProfileSection: vi.fn() }));

import { injuryCheckStep } from '../steps/03-injury-check';

const cb = (data: string, partial: Record<string, unknown> = {}) =>
  injuryCheckStep.handleCallback!(data, partial, 'a1');
const msg = (text: string, partial: Record<string, unknown> = {}) =>
  injuryCheckStep.handleMessage!(text, partial, 'a1');

describe('injury-check — A7 light capture', () => {
  it('All good completes with no body part', async () => {
    const r = await cb('injury:none', { sub_step: 'asking' });
    expect(r.done).toBe(true);
    expect((r.newPartial as { body_part?: string }).body_part).toBeUndefined();
  });

  it('Something bothering me captures part then status (bugging → active)', async () => {
    const start = await cb('injury:some', { sub_step: 'asking' });
    expect((start.newPartial as { sub_step: string }).sub_step).toBe('capture_part');

    const part = await msg('left knee', start.newPartial);
    expect((part.newPartial as { body_part: string; sub_step: string }).body_part).toBe('left knee');
    expect((part.newPartial as { sub_step: string }).sub_step).toBe('capture_status');

    const done = await msg("it's still bugging me", part.newPartial);
    expect(done.done).toBe(true);
    expect((done.newPartial as { status: string }).status).toBe('active');
  });

  it('watch maps to monitoring', async () => {
    const done = await msg('just keeping an eye on it', {
      sub_step: 'capture_status',
      body_part: 'achilles',
    });
    expect(done.done).toBe(true);
    expect((done.newPartial as { status: string }).status).toBe('monitoring');
  });

  it('typing on the ask screen nudges to tap', async () => {
    const r = await msg('hello', { sub_step: 'asking' });
    expect(r.done).toBe(false);
  });
});
