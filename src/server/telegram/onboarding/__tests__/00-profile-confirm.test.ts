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
  it('Yep accepts the Strava firstname and keeps the derived timezone', async () => {
    const r = await cb('profile:yep', {
      sub_step: 'confirm_name',
      strava_firstname: 'Dana',
      strava_timezone: 'America/Los_Angeles',
    });
    expect(r.done).toBe(true);
    expect((r.newPartial as { name: string }).name).toBe('Dana');
    expect((r.newPartial as { strava_timezone: string }).strava_timezone).toBe('America/Los_Angeles');
  });

  it('Not quite routes to a free-text name ask with a Keep button', async () => {
    const r = await cb('profile:fix', { sub_step: 'confirm_name', strava_firstname: 'Dana' });
    expect(r.done).toBe(false);
    if (!r.done) {
      expect((r.newPartial as { sub_step: string }).sub_step).toBe('ask_name');
      expect(r.replyMarkup).toBeDefined();
    }
  });

  it('typing a name in confirm_name advances to the timezone picker', async () => {
    const r = await msg('Dre', { sub_step: 'confirm_name', strava_firstname: 'Dana' });
    expect(r.done).toBe(false);
    if (!r.done) {
      expect((r.newPartial as { name: string }).name).toBe('Dre');
      expect((r.newPartial as { sub_step: string }).sub_step).toBe('ask_timezone');
      expect(r.replyMarkup).toBeDefined();
    }
  });
});

describe('profile-confirm — correction flow (name + timezone)', () => {
  it('Keep retains the Strava name and advances to the timezone picker', async () => {
    const r = await cb('profile:keepname', { sub_step: 'ask_name', strava_firstname: 'Dana' });
    expect(r.done).toBe(false);
    if (!r.done) {
      expect((r.newPartial as { name: string }).name).toBe('Dana');
      expect((r.newPartial as { sub_step: string }).sub_step).toBe('ask_timezone');
    }
  });

  it('picking a zone sets the canonical IANA timezone and completes', async () => {
    const r = await cb('profile:tz:pacific', { sub_step: 'ask_timezone', name: 'Dana' });
    expect(r.done).toBe(true);
    expect((r.newPartial as { strava_timezone: string }).strava_timezone).toBe('America/Los_Angeles');
    expect((r.newPartial as { name: string }).name).toBe('Dana');
  });

  it('Somewhere else keeps whatever Strava derived', async () => {
    const r = await cb('profile:tz:keep', {
      sub_step: 'ask_timezone',
      name: 'Dana',
      strava_timezone: 'Europe/London',
    });
    expect(r.done).toBe(true);
    expect((r.newPartial as { strava_timezone: string }).strava_timezone).toBe('Europe/London');
  });

  it('typing in the timezone step re-shows the picker without clobbering the name', async () => {
    const r = await msg('pacific', { sub_step: 'ask_timezone', name: 'Dana' });
    expect(r.done).toBe(false);
    if (!r.done) {
      expect((r.newPartial as { name: string }).name).toBe('Dana');
      expect((r.newPartial as { sub_step: string }).sub_step).toBe('ask_timezone');
      expect(r.replyMarkup).toBeDefined();
    }
  });

  it('a stale confirm-screen tap after advancing is a no-op', async () => {
    const r = await cb('profile:fix', { sub_step: 'ask_timezone', name: 'Dana' });
    expect(r.done).toBe(false);
    if (!r.done) expect(r.reply).toBeUndefined();
  });
});

describe('profile-confirm — pre-connect + privacy-null fallbacks', () => {
  it('typing before connecting nudges to the Strava button', async () => {
    const r = await msg('hi', { sub_step: 'awaiting_strava' });
    expect(r.done).toBe(false);
    if (!r.done) expect(r.reply).toContain('/strava/connect');
  });

  it('ask_name (no Strava name) advances to the timezone picker', async () => {
    const r = await msg('Sam', { sub_step: 'ask_name' });
    expect(r.done).toBe(false);
    if (!r.done) {
      expect((r.newPartial as { name: string }).name).toBe('Sam');
      expect((r.newPartial as { sub_step: string }).sub_step).toBe('ask_timezone');
    }
  });

  it('rejects an empty name', async () => {
    const r = await msg('   ', { sub_step: 'ask_name' });
    expect(r.done).toBe(false);
  });
});
