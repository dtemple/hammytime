import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/lib/anthropic', () => ({ anthropicClient: vi.fn() }));

import { supabaseAdmin } from '@/lib/db';
import { anthropicClient } from '@/lib/anthropic';
import { lookupRace, normalizeName } from '../race-lookup';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

function makeDbNoCache() {
  const insertMock = vi.fn().mockResolvedValue({ error: null });
  const upsertMock = vi.fn().mockResolvedValue({ error: null });
  const maybeSingleMock = vi.fn().mockResolvedValue({ data: null, error: null });

  const eqChain = {
    eq: vi.fn().mockReturnThis(),
    maybeSingle: maybeSingleMock,
  };
  eqChain.eq.mockReturnValue(eqChain);

  const fromMock = vi.fn().mockImplementation(() => ({
    select: vi.fn().mockReturnValue(eqChain),
    insert: insertMock,
    upsert: upsertMock,
  }));

  return { from: fromMock, insertMock, upsertMock };
}

function makeDbCacheHit(resultData: unknown, expired = false) {
  const expiresAt = expired
    ? new Date(Date.now() - 1000).toISOString()
    : new Date(Date.now() + 86400000).toISOString();

  const maybeSingleMock = vi.fn().mockResolvedValue({
    data: { result: resultData, expires_at: expiresAt },
    error: null,
  });

  const eqChain = {
    eq: vi.fn().mockReturnThis(),
    maybeSingle: maybeSingleMock,
  };
  eqChain.eq.mockReturnValue(eqChain);

  const fromMock = vi.fn().mockImplementation(() => ({
    select: vi.fn().mockReturnValue(eqChain),
    insert: vi.fn().mockResolvedValue({ error: null }),
    upsert: vi.fn().mockResolvedValue({ error: null }),
  }));

  return { from: fromMock };
}

// ---------------------------------------------------------------------------
// Anthropic mock helpers
// ---------------------------------------------------------------------------

function makeAnthropicFoundResponse(overrides?: Partial<AnyMock>) {
  const toolInput = {
    result_type: 'found',
    found: {
      canonical_name: 'Chicago Marathon',
      date: '2026-10-04',
      distance_mi: 26.2,
      elevation_ft: 450,
      terrain: 'road',
      source_url: 'https://www.chicagomarathon.com',
      confidence: 'high',
    },
    ...overrides,
  };

  return {
    stop_reason: 'tool_use',
    usage: { input_tokens: 500, output_tokens: 100 },
    content: [
      {
        type: 'tool_use',
        name: 'report_race_details',
        input: toolInput,
      },
    ],
  };
}

function makeAnthropicNotFoundResponse() {
  return {
    stop_reason: 'tool_use',
    usage: { input_tokens: 300, output_tokens: 50 },
    content: [
      {
        type: 'tool_use',
        name: 'report_race_details',
        input: { result_type: 'not_found' },
      },
    ],
  };
}

function makeAnthropicAmbiguousResponse() {
  return {
    stop_reason: 'tool_use',
    usage: { input_tokens: 600, output_tokens: 150 },
    content: [
      {
        type: 'tool_use',
        name: 'report_race_details',
        input: {
          result_type: 'ambiguous',
          candidates: [
            {
              canonical_name: 'Boston Marathon (US)',
              date: '2026-04-20',
              distance_mi: 26.2,
              confidence: 'high',
            },
            {
              canonical_name: 'Boston Marathon (Canada)',
              date: '2026-09-15',
              distance_mi: 26.2,
              confidence: 'medium',
            },
          ],
        },
      },
    ],
  };
}

function makeAnthropicMalformedResponse() {
  return {
    stop_reason: 'tool_use',
    usage: { input_tokens: 200, output_tokens: 30 },
    content: [
      {
        type: 'tool_use',
        name: 'report_race_details',
        input: { garbage: 'data' },
      },
    ],
  };
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// normalizeName unit tests
// ---------------------------------------------------------------------------

describe('normalizeName', () => {
  it('lowercases and trims', () => {
    expect(normalizeName('  Boston Marathon  ')).toBe('boston marathon');
  });

  it('strips 4-digit years', () => {
    expect(normalizeName('Boston Marathon 2026')).toBe('boston marathon');
    expect(normalizeName('Chicago Marathon 2025')).toBe('chicago marathon');
  });

  it('collapses whitespace', () => {
    expect(normalizeName('Boston  Marathon')).toBe('boston marathon');
  });
});

// ---------------------------------------------------------------------------
// lookupRace — cache miss path
// ---------------------------------------------------------------------------

describe('lookupRace — cache miss', () => {
  it('calls Anthropic and writes cache + agent_runs on miss', async () => {
    const db = makeDbNoCache();
    vi.mocked(supabaseAdmin as AnyMock).mockReturnValue({ from: db.from });

    const betaCreateMock = vi.fn().mockResolvedValue(makeAnthropicFoundResponse());
    vi.mocked(anthropicClient as AnyMock).mockReturnValue({
      beta: { messages: { create: betaCreateMock } },
    });

    const result = await lookupRace('Chicago Marathon', 'athlete-1');

    expect(betaCreateMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true });
    if (result.ok && 'found' in result) {
      expect(result.found.canonical_name).toBe('Chicago Marathon');
      expect(result.found.confidence).toBe('high');
    }

    // Cache upsert and agent_runs insert should both be called
    expect(db.upsertMock).toHaveBeenCalled();
    expect(db.insertMock).toHaveBeenCalled();
    const insertCall = db.insertMock.mock.calls[0]![0] as AnyMock;
    expect(insertCall.kind).toBe('race_lookup');
    expect(insertCall.athlete_id).toBe('athlete-1');
    expect(insertCall.input_tokens).toBe(500);
    expect(insertCall.cost_usd).toBeGreaterThan(0);
  });

  it('returns not_found and caches it (prevents hammering API)', async () => {
    const db = makeDbNoCache();
    vi.mocked(supabaseAdmin as AnyMock).mockReturnValue({ from: db.from });

    const betaCreateMock = vi.fn().mockResolvedValue(makeAnthropicNotFoundResponse());
    vi.mocked(anthropicClient as AnyMock).mockReturnValue({
      beta: { messages: { create: betaCreateMock } },
    });

    const result = await lookupRace('UnknownRaceXYZ123', 'athlete-1');

    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(db.upsertMock).toHaveBeenCalled(); // cache written even for not_found
  });

  it('returns ambiguous result with candidates array', async () => {
    const db = makeDbNoCache();
    vi.mocked(supabaseAdmin as AnyMock).mockReturnValue({ from: db.from });

    const betaCreateMock = vi.fn().mockResolvedValue(makeAnthropicAmbiguousResponse());
    vi.mocked(anthropicClient as AnyMock).mockReturnValue({
      beta: { messages: { create: betaCreateMock } },
    });

    const result = await lookupRace('Boston Marathon', 'athlete-1');

    expect(result.ok).toBe(true);
    if (result.ok && 'ambiguous' in result) {
      expect(result.ambiguous).toHaveLength(2);
      expect(result.ambiguous[0]!.canonical_name).toBe('Boston Marathon (US)');
    }
  });

  it('retries once on malformed Zod response, returns error on second failure', async () => {
    const db = makeDbNoCache();
    vi.mocked(supabaseAdmin as AnyMock).mockReturnValue({ from: db.from });

    // Return malformed twice
    const betaCreateMock = vi
      .fn()
      .mockResolvedValueOnce(makeAnthropicMalformedResponse())
      .mockResolvedValueOnce(makeAnthropicMalformedResponse());

    vi.mocked(anthropicClient as AnyMock).mockReturnValue({
      beta: { messages: { create: betaCreateMock } },
    });

    const result = await lookupRace('Some Race', 'athlete-1');

    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(betaCreateMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// lookupRace — cache hit path
// ---------------------------------------------------------------------------

describe('lookupRace — cache hit', () => {
  it('returns cached result without calling Anthropic', async () => {
    const cachedResult = {
      ok: true,
      found: {
        canonical_name: 'Boston Marathon',
        date: '2026-04-20',
        distance_mi: 26.2,
        elevation_ft: 800,
        terrain: 'road',
        source_url: 'https://www.baa.org',
        confidence: 'high',
      },
    };

    const db = makeDbCacheHit(cachedResult);
    vi.mocked(supabaseAdmin as AnyMock).mockReturnValue({ from: db.from });

    const betaCreateMock = vi.fn();
    vi.mocked(anthropicClient as AnyMock).mockReturnValue({
      beta: { messages: { create: betaCreateMock } },
    });

    const result = await lookupRace('Boston Marathon', 'athlete-1');

    expect(betaCreateMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true });
  });

  it('calls Anthropic when cache entry is expired', async () => {
    const cachedResult = { ok: true, found: { canonical_name: 'Old Race', confidence: 'high' } };
    const db = makeDbCacheHit(cachedResult, /* expired= */ true);
    vi.mocked(supabaseAdmin as AnyMock).mockReturnValue({ from: db.from });

    const betaCreateMock = vi.fn().mockResolvedValue(makeAnthropicFoundResponse());
    vi.mocked(anthropicClient as AnyMock).mockReturnValue({
      beta: { messages: { create: betaCreateMock } },
    });

    await lookupRace('Chicago Marathon', 'athlete-1');

    expect(betaCreateMock).toHaveBeenCalled();
  });

  it('skips agent_runs when no athleteId is provided', async () => {
    const db = makeDbNoCache();
    vi.mocked(supabaseAdmin as AnyMock).mockReturnValue({ from: db.from });

    const betaCreateMock = vi.fn().mockResolvedValue(makeAnthropicFoundResponse());
    vi.mocked(anthropicClient as AnyMock).mockReturnValue({
      beta: { messages: { create: betaCreateMock } },
    });

    await lookupRace('Chicago Marathon'); // no athleteId

    // upsert (cache) called, insert (agent_runs) NOT called
    expect(db.upsertMock).toHaveBeenCalled();
    expect(db.insertMock).not.toHaveBeenCalled();
  });
});
