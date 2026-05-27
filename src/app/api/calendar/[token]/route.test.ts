import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/lib/db', () => ({
  supabaseAdmin: vi.fn(),
}));

import { GET } from './route';
import { supabaseAdmin } from '@/lib/db';

const seedPath = join(__dirname, '../../../../../seeds/marathon_training_plan.json');
const seedPlanJson = JSON.parse(readFileSync(seedPath, 'utf-8'));

type LinkRow = { athlete_id: string | null; expires_at: string | null; purpose: string } | null;
type AthleteRow = { name: string; timezone: string } | null;
type PlanRow = { id: string; start_date: string | null; current_version_id: string | null } | null;
type VersionRow = { id: string; plan_json: unknown } | null;

function makeDb(opts: {
  link?: LinkRow;
  linkError?: { message: string };
  athlete?: AthleteRow;
  plan?: PlanRow;
  version?: VersionRow;
}) {
  // link_tokens chain: .from('link_tokens').select(...).eq.eq.maybeSingle()
  function linkTokensChain() {
    const maybeSingle = vi
      .fn()
      .mockResolvedValue({ data: opts.link ?? null, error: opts.linkError ?? null });
    const eq2 = vi.fn().mockReturnValue({ maybeSingle });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    return { select };
  }
  // athletes chain: .from('athletes').select(...).eq().maybeSingle()
  function athletesChain() {
    const maybeSingle = vi.fn().mockResolvedValue({ data: opts.athlete ?? null, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    return { select };
  }
  // plans chain: .from('plans').select(...).eq().order().limit().maybeSingle()
  function plansChain() {
    const maybeSingle = vi.fn().mockResolvedValue({ data: opts.plan ?? null, error: null });
    const limit = vi.fn().mockReturnValue({ maybeSingle });
    const order = vi.fn().mockReturnValue({ limit });
    const eq = vi.fn().mockReturnValue({ order });
    const select = vi.fn().mockReturnValue({ eq });
    return { select };
  }
  // plan_versions chain: .from('plan_versions').select(...).eq().maybeSingle()
  function planVersionsChain() {
    const maybeSingle = vi.fn().mockResolvedValue({ data: opts.version ?? null, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    return { select };
  }

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'link_tokens') return linkTokensChain();
    if (table === 'athletes') return athletesChain();
    if (table === 'plans') return plansChain();
    if (table === 'plan_versions') return planVersionsChain();
    throw new Error(`unexpected table: ${table}`);
  });
  return { from };
}

async function callGET(token: string) {
  return GET(new Request(`http://localhost/api/calendar/${token}`), {
    params: Promise.resolve({ token }),
  });
}

describe('GET /api/calendar/[token].ics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('404s when the token does not exist', async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeDb({ link: null }) as unknown as ReturnType<typeof supabaseAdmin>,
    );
    const res = await callGET('missing.ics');
    expect(res.status).toBe(404);
  });

  it('404s when the token is expired', async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeDb({
        link: { athlete_id: 'a1', expires_at: '2000-01-01T00:00:00Z', purpose: 'calendar' },
      }) as unknown as ReturnType<typeof supabaseAdmin>,
    );
    const res = await callGET('expired.ics');
    expect(res.status).toBe(404);
  });

  it('404s when the athlete row is missing (orphaned token)', async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeDb({
        link: { athlete_id: 'a1', expires_at: '2099-01-01T00:00:00Z', purpose: 'calendar' },
        athlete: null,
      }) as unknown as ReturnType<typeof supabaseAdmin>,
    );
    const res = await callGET('orphan.ics');
    expect(res.status).toBe(404);
  });

  it('returns 200 with a valid empty calendar when athlete has no active plan', async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeDb({
        link: { athlete_id: 'a1', expires_at: '2099-01-01T00:00:00Z', purpose: 'calendar' },
        athlete: { name: 'David', timezone: 'America/Los_Angeles' },
        plan: { id: 'p1', start_date: null, current_version_id: null },
      }) as unknown as ReturnType<typeof supabaseAdmin>,
    );
    const res = await callGET('valid.ics');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/calendar');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('no active training plan');
    expect(body).not.toContain('BEGIN:VEVENT');
  });

  it('returns 200 with events when athlete has an active plan', async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeDb({
        link: { athlete_id: 'a1', expires_at: '2099-01-01T00:00:00Z', purpose: 'calendar' },
        athlete: { name: 'David', timezone: 'America/Los_Angeles' },
        plan: { id: 'p1', start_date: '2026-03-30', current_version_id: 'v1' },
        version: { id: 'v1', plan_json: seedPlanJson },
      }) as unknown as ReturnType<typeof supabaseAdmin>,
    );
    const res = await callGET('full.ics');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('BEGIN:VEVENT');
    // 22 weeks × 7 days = 154 events
    const eventCount = (body.match(/BEGIN:VEVENT/g) ?? []).length;
    expect(eventCount).toBe(
      seedPlanJson.weeks.reduce((n: number, w: { days: unknown[] }) => n + w.days.length, 0),
    );
    expect(body).toContain('v1-w1-d0@hammytime');
  });
});
