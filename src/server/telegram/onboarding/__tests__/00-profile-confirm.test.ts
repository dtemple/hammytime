import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('../../bot', () => ({ stravaConnectUrl: (id: string) => `https://app.test/strava/connect?athlete_id=${id}` }));
vi.mock('../memory', () => ({ upsertProfileSection: vi.fn() }));

import { profileConfirmStep } from '../steps/00-profile-confirm';

const cb = (data: string, partial: Record<string, unknown>) =>
  profileConfirmStep.handleCallback!(data, partial, 'a1');
const msg = (text: string, partial: Record<string, unknown>) =>
  profileConfirmStep.handleMessage!(text, partial, 'a1');

describe('profile-confirm — name confirmation (A1)', () => {
  it('Yep accepts the Strava firstname', async () => {
    const r = await cb('profile:yep', { sub_step: 'confirm_name', strava_firstname: 'Dana' });
    expect(r.done).toBe(true);
    expect((r.newPartial as { name: string }).name).toBe('Dana');
  });

  it('I-go-by routes to a free-text name ask', async () => {
    const r = await cb('profile:rename', { sub_step: 'confirm_name', strava_firstname: 'Dana' });
    expect(r.done).toBe(false);
    if (!r.done) expect((r.newPartial as { sub_step: string }).sub_step).toBe('ask_name');
  });

  it('typing a name in confirm_name accepts it directly', async () => {
    const r = await msg('Dre', { sub_step: 'confirm_name', strava_firstname: 'Dana' });
    expect(r.done).toBe(true);
    expect((r.newPartial as { name: string }).name).toBe('Dre');
  });
});

describe('profile-confirm — pre-connect + privacy-null fallbacks', () => {
  it('typing before connecting nudges to the Strava button', async () => {
    const r = await msg('hi', { sub_step: 'awaiting_strava' });
    expect(r.done).toBe(false);
    if (!r.done) expect(r.reply).toContain('/strava/connect');
  });

  it('ask_name (no Strava name) accepts a valid typed name', async () => {
    const r = await msg('Sam', { sub_step: 'ask_name' });
    expect(r.done).toBe(true);
    expect((r.newPartial as { name: string }).name).toBe('Sam');
  });

  it('rejects an empty name', async () => {
    const r = await msg('   ', { sub_step: 'ask_name' });
    expect(r.done).toBe(false);
  });
});
