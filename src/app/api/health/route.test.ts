import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  supabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/anthropic', () => ({
  pingAnthropic: vi.fn(),
}));

vi.mock('@/server/strava/client', () => ({
  pingStrava: vi.fn(),
}));

import { GET } from './route';
import { supabaseAdmin } from '@/lib/db';
import { pingAnthropic } from '@/lib/anthropic';
import { pingStrava } from '@/server/strava/client';

function makeSupabaseMock(result: { data?: unknown; error: null | { message: string } }) {
  const limit = vi.fn().mockResolvedValue(result);
  const select = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ select });
  return { from };
}

function mockPostgresOk() {
  vi.mocked(supabaseAdmin).mockReturnValue(
    makeSupabaseMock({ data: [], error: null }) as unknown as ReturnType<typeof supabaseAdmin>,
  );
}

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns the expected response shape', async () => {
    mockPostgresOk();

    const response = await GET();
    const body = await response.json();

    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('checks.postgres.ok');
    expect(body).toHaveProperty('checks.postgres.latency_ms');
    expect(body).toHaveProperty('checks.anthropic');
    expect(body).toHaveProperty('checks.telegram');
    expect(body).toHaveProperty('checks.strava');
  });

  it('returns status=ok when postgres succeeds and anthropic is not configured', async () => {
    mockPostgresOk();

    const response = await GET();
    const body = await response.json();

    expect(body.status).toBe('ok');
    expect(body.checks.postgres.ok).toBe(true);
    expect(body.checks.anthropic.configured).toBe(false);
  });

  it('returns status=error when postgres fails', async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeSupabaseMock({ error: { message: 'connection refused' } }) as unknown as ReturnType<
        typeof supabaseAdmin
      >,
    );

    const response = await GET();
    const body = await response.json();

    expect(body.status).toBe('error');
    expect(body.checks.postgres.ok).toBe(false);
    expect(body.checks.postgres.error).toBe('connection refused');
  });

  it('returns status=error when supabaseAdmin throws', async () => {
    vi.mocked(supabaseAdmin).mockImplementation(() => {
      throw new Error('no env vars');
    });

    const response = await GET();
    const body = await response.json();

    expect(body.status).toBe('error');
    expect(body.checks.postgres.ok).toBe(false);
  });

  it('sets Cache-Control: no-store header', async () => {
    mockPostgresOk();

    const response = await GET();

    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  describe('anthropic check — stub (no ANTHROPIC_API_KEY)', () => {
    it('returns configured=false and skips the ping', async () => {
      mockPostgresOk();

      const response = await GET();
      const body = await response.json();

      expect(body.checks.anthropic.configured).toBe(false);
      expect(body.checks.anthropic.ok).toBe(false);
      expect(pingAnthropic).not.toHaveBeenCalled();
    });
  });

  describe('anthropic check — real key set', () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    });

    it('returns ok=true and latency_ms when ping succeeds', async () => {
      mockPostgresOk();
      vi.mocked(pingAnthropic).mockResolvedValue({ latency_ms: 42 });

      const response = await GET();
      const body = await response.json();

      expect(body.checks.anthropic.configured).toBe(true);
      expect(body.checks.anthropic.ok).toBe(true);
      expect(body.checks.anthropic.latency_ms).toBe(42);
      expect(body.status).toBe('ok');
    });

    it('returns ok=false and status=degraded when ping throws', async () => {
      mockPostgresOk();
      vi.mocked(pingAnthropic).mockRejectedValue(new Error('api error'));

      const response = await GET();
      const body = await response.json();

      expect(body.checks.anthropic.configured).toBe(true);
      expect(body.checks.anthropic.ok).toBe(false);
      expect(body.checks.anthropic.error).toContain('api error');
      expect(body.status).toBe('degraded');
    });
  });

  describe('strava webhook check', () => {
    const realFetch = global.fetch;
    beforeEach(() => {
      process.env.STRAVA_CLIENT_ID = 'cid';
      process.env.STRAVA_CLIENT_SECRET = 'csecret';
      // Setting the client id also activates the OAuth ping check; keep it green
      // so it doesn't perturb the status we're asserting on.
      vi.mocked(pingStrava).mockResolvedValue({ ok: true, latency_ms: 5 });
    });
    afterEach(() => {
      delete process.env.STRAVA_CLIENT_ID;
      delete process.env.STRAVA_CLIENT_SECRET;
      global.fetch = realFetch;
    });

    it('returns ok=true when at least one subscription exists', async () => {
      mockPostgresOk();
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ id: 1, callback_url: 'https://www.daybreak.run/api/strava/webhook' }],
      }) as unknown as typeof fetch;

      const body = await (await GET()).json();

      expect(body.checks.stravaWebhook.configured).toBe(true);
      expect(body.checks.stravaWebhook.ok).toBe(true);
      expect(body.checks.stravaWebhook.count).toBe(1);
      expect(body.checks.stravaWebhook.callback).toContain('www.daybreak.run');
      expect(body.status).toBe('ok');
    });

    it('returns status=degraded when configured but no subscription exists', async () => {
      mockPostgresOk();
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      }) as unknown as typeof fetch;

      const body = await (await GET()).json();

      expect(body.checks.stravaWebhook.configured).toBe(true);
      expect(body.checks.stravaWebhook.ok).toBe(false);
      expect(body.checks.stravaWebhook.count).toBe(0);
      expect(body.status).toBe('degraded');
    });

    it('is configured=false (and does not fetch) when client creds are unset', async () => {
      delete process.env.STRAVA_CLIENT_ID;
      delete process.env.STRAVA_CLIENT_SECRET;
      mockPostgresOk();
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;

      const body = await (await GET()).json();

      expect(body.checks.stravaWebhook.configured).toBe(false);
      expect(body.checks.stravaWebhook.ok).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(body.status).toBe('ok');
    });
  });
});
