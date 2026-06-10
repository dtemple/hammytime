import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildPrompt,
  safetyCapsBlock,
  renderSystemPrompt,
  easeInContext,
  planExtensionContext,
} from '../system-prompt';
import { DRAFT_SAFETY_CAPS } from '@/lib/plan-templates/caps';
import type { Plan } from '@/lib/plan-schema';

// renderSystemPrompt's only DB dependency is loadAthleteData; mock it so the
// three-way goal branch + coach.md template fill (V3-W7) is testable. The
// template itself is read from the real worker/prompts/coach.md on disk. The
// pure-helper suites below don't touch these mocks.
const { mockLoadAthleteData } = vi.hoisted(() => ({ mockLoadAthleteData: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/agent/byo-plan', () => ({ loadAthleteData: mockLoadAthleteData }));

const TZ = 'America/Los_Angeles';

describe('coach prompt — safety caps share one source of truth', () => {
  it('coach.md carries the {{safety_caps}} placeholder', () => {
    const md = readFileSync(join(process.cwd(), 'worker/prompts/coach.md'), 'utf8');
    expect(md).toContain('{{safety_caps}}');
    // and the advisory policy is stated (warn + confirm + comply, never refuse)
    expect(md.toLowerCase()).toContain('never');
    expect(md).toMatch(/advisory/i);
  });

  it('renders the locked caps numbers from caps.ts (not hardcoded prose)', () => {
    const block = safetyCapsBlock(DRAFT_SAFETY_CAPS, 26.2);
    expect(block).toContain(`${Math.round(DRAFT_SAFETY_CAPS.maxWeeklyRampPct * 100)}%`);
    expect(block).toContain(`${DRAFT_SAFETY_CAPS.minWeeklyRampMi} mi`);
    expect(block).toContain(`+${DRAFT_SAFETY_CAPS.maxLongRunStepMi} mi`);
    expect(block).toContain(`${Math.round(DRAFT_SAFETY_CAPS.maxLongRunShareOfWeekly * 100)}%`);
  });

  it('picks the long-run ceiling by the athlete’s race distance', () => {
    expect(safetyCapsBlock(DRAFT_SAFETY_CAPS, 26.2)).toContain(
      `about ${DRAFT_SAFETY_CAPS.maxLongRunMiByDistance.marathon} mi`,
    );
    expect(safetyCapsBlock(DRAFT_SAFETY_CAPS, 13.1)).toContain(
      `about ${DRAFT_SAFETY_CAPS.maxLongRunMiByDistance.half} mi`,
    );
    expect(safetyCapsBlock(DRAFT_SAFETY_CAPS, 3.1)).toContain(
      `about ${DRAFT_SAFETY_CAPS.maxLongRunMiByDistance['5k']} mi`,
    );
  });

  it('falls back to the full per-distance list when there’s no race', () => {
    const block = safetyCapsBlock(DRAFT_SAFETY_CAPS, null);
    expect(block).toContain(`marathon ${DRAFT_SAFETY_CAPS.maxLongRunMiByDistance.marathon} mi`);
  });
});

describe('buildPrompt — post_activity', () => {
  it('directs the agent to the post-activity note and includes the activity id hint', () => {
    const prompt = buildPrompt('post_activity', TZ, undefined, [], 1360128428);
    expect(prompt).toContain('just completed an activity');
    expect(prompt).toContain('Strava id 1360128428');
    expect(prompt).toContain('strava_recent.json');
    // It must not auto-edit the plan this turn — only acknowledge + ask.
    expect(prompt).toMatch(/Don't change the plan/i);
  });

  it('omits the id hint when no activity id is passed', () => {
    const prompt = buildPrompt('post_activity', TZ);
    expect(prompt).toContain('just completed an activity');
    expect(prompt).not.toContain('Strava id');
  });

  it('appends recent conversation when there is history', () => {
    const prompt = buildPrompt(
      'post_activity',
      TZ,
      undefined,
      [{ direction: 'in', body: 'thanks coach' }],
      42,
    );
    expect(prompt).toContain('Recent conversation, oldest first:');
    expect(prompt).toContain('Athlete: thanks coach');
  });
});

describe('renderSystemPrompt — three-way goal branch (V3-W7)', () => {
  const baseAthlete = {
    id: 'a1',
    name: 'Sam',
    dob: '1990-01-01',
    sex: 'M',
    timezone: TZ,
    notes: null,
    asthma: false,
    telegram_chat_id: '123',
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function loaded(overrides: Record<string, unknown>): any {
    return {
      athlete: baseAthlete,
      goalRace: null,
      tuneupRaces: [],
      pastRace: null,
      injuries: [],
      profileMd: '',
      trainingProfile: null,
      ...overrides,
    };
  }

  const committedRace = {
    id: 'r1',
    name: 'CIM',
    date: '2026-12-06',
    distance_mi: 26.2,
    elevation_ft: 300,
    terrain: 'road',
    target_type: 'finish',
    target_time_sec: null,
    status: 'upcoming',
    created_at: '2026-06-01',
  };

  const profile = (goal_state: string, goal_distance: string) => ({
    athlete_id: 'a1',
    goal_type: goal_state === 'day_to_day' ? 'day_to_day' : 'race',
    goal_state,
    goal_distance,
    experience_tier: 'some_training',
    days_per_week: 4,
    long_run_day: 0,
    target_date: null,
    goal_race_id: null,
    created_at: '2026-06-01',
    updated_at: '2026-06-01',
  });

  beforeEach(() => vi.clearAllMocks());

  it('leaves no residual {{placeholders}} in any mode', async () => {
    const fixtures = [
      loaded({ goalRace: committedRace, trainingProfile: profile('committed', 'marathon') }),
      loaded({ trainingProfile: profile('intended', 'half') }),
      loaded({ trainingProfile: profile('day_to_day', 'keep_fit') }),
      loaded({}), // legacy: no profile, no race
    ];
    for (const data of fixtures) {
      mockLoadAthleteData.mockResolvedValueOnce(data);
      const out = await renderSystemPrompt('a1');
      expect(out).not.toContain('{{');
      expect(out).not.toContain('}}');
    }
  });

  it('mission line no longer carries the prehab clause in either mode (prehab v2)', async () => {
    const fixtures = [
      loaded({ goalRace: committedRace, trainingProfile: profile('committed', 'marathon') }),
      loaded({ trainingProfile: profile('day_to_day', 'keep_fit') }),
    ];
    for (const data of fixtures) {
      mockLoadAthleteData.mockResolvedValueOnce(data);
      const out = await renderSystemPrompt('a1');
      // coach.md §Prehab owns cadence now; the mission sentence must not.
      expect(out).not.toContain('including prehab');
      expect(out).toContain('every time you write to them');
    }
  });

  it('committed race: marathon framing + goal-pace logic', async () => {
    mockLoadAthleteData.mockResolvedValueOnce(
      loaded({ goalRace: committedRace, trainingProfile: profile('committed', 'marathon') }),
    );
    const out = await renderSystemPrompt('a1');
    expect(out).toContain('# Marathon coach');
    expect(out).toContain('toward their goal race');
    expect(out).toContain('Goal race: CIM');
    expect(out).toContain('first goal-pace session');
    expect(out).toContain('tune-up races');
  });

  it('intended: still race-framed, nudges to lock a race', async () => {
    mockLoadAthleteData.mockResolvedValueOnce(
      loaded({ trainingProfile: profile('intended', 'half') }),
    );
    const out = await renderSystemPrompt('a1');
    expect(out).toContain('# Marathon coach');
    expect(out).toContain('half marathon in mind');
    expect(out).toContain('no race picked yet');
    expect(out).toContain('first goal-pace session'); // race-only logic kept
  });

  it('no-race / keep_fit: consistency framing, no race/goal-pace logic', async () => {
    mockLoadAthleteData.mockResolvedValueOnce(
      loaded({ trainingProfile: profile('day_to_day', 'keep_fit') }),
    );
    const out = await renderSystemPrompt('a1');
    expect(out).toContain('# Running coach');
    expect(out).toContain('no race on the calendar');
    expect(out).not.toContain('toward their goal race');
    expect(out).not.toContain('first goal-pace session');
    expect(out).not.toContain('tune-up races'); // suppressed in the gaps examples
    expect(out).toContain('effort-led');
  });

  it('no-race + intended: warned off the plan file placeholder race; committed is not', async () => {
    for (const p of [profile('day_to_day', 'keep_fit'), profile('intended', 'half')]) {
      mockLoadAthleteData.mockResolvedValueOnce(loaded({ trainingProfile: p }));
      const out = await renderSystemPrompt('a1');
      expect(out).toContain('schema-required placeholder');
    }
    mockLoadAthleteData.mockResolvedValueOnce(
      loaded({ goalRace: committedRace, trainingProfile: profile('committed', 'marathon') }),
    );
    expect(await renderSystemPrompt('a1')).not.toContain('schema-required placeholder');
  });

  it('no-race: daily lead is the consistency story, with the profile runs/week target rendered (GF-W2)', async () => {
    mockLoadAthleteData.mockResolvedValueOnce(
      loaded({ trainingProfile: profile('day_to_day', 'keep_fit') }),
    );
    const out = await renderSystemPrompt('a1');
    expect(out).toContain('consistency story');
    expect(out).toContain('their target of 4 runs/week'); // days_per_week from the profile row
    expect(out).toContain('North-star goal'); // pocket tie-in, self-conditional on the file
    expect(out).toContain('checkin_log.md'); // vary-the-through-line checks a concrete source
    expect(out).not.toContain('on track, minor concern, or off track');
  });

  it('no-race without days_per_week: falls back to the plan-prescribed run days', async () => {
    mockLoadAthleteData.mockResolvedValueOnce(
      loaded({ trainingProfile: { ...profile('day_to_day', 'keep_fit'), days_per_week: null } }),
    );
    const out = await renderSystemPrompt('a1');
    expect(out).toContain('the run days the plan prescribes');
    expect(out).not.toContain('their target of');
  });

  it('committed/intended/legacy: daily lead keeps the status line verbatim, no narrative block (GF-W2)', async () => {
    const fixtures = [
      loaded({ goalRace: committedRace, trainingProfile: profile('committed', 'marathon') }),
      loaded({ trainingProfile: profile('intended', 'half') }),
      loaded({}),
    ];
    for (const data of fixtures) {
      mockLoadAthleteData.mockResolvedValueOnce(data);
      const out = await renderSystemPrompt('a1');
      expect(out).toContain(
        "Today's status in a sentence or two — on track, minor concern, or off track, read off recent Strava and the plan.",
      );
      expect(out).not.toContain('consistency story');
      expect(out).not.toContain('North-star goal');
    }
  });

  it('legacy athlete with no profile: preserves the old "not set yet" line', async () => {
    mockLoadAthleteData.mockResolvedValueOnce(loaded({}));
    const out = await renderSystemPrompt('a1');
    expect(out).toContain('# Marathon coach');
    expect(out).toContain('Goal race: not set yet');
  });
});

describe('planExtensionContext — announce-the-new-block signal (GF-W1)', () => {
  it('empty on every run without a just-landed extension', () => {
    expect(planExtensionContext(undefined)).toBe('');
  });

  it('carries the new end date and block size, no residual placeholders', () => {
    const out = planExtensionContext({ newEndDate: '2026-09-27', blockWeeks: 8 });
    expect(out).toContain('2026-09-27');
    expect(out).toContain('8-week block');
    expect(out).not.toContain('{{');
  });

  it('renders into the system prompt when passed through renderSystemPrompt', async () => {
    mockLoadAthleteData.mockResolvedValueOnce({
      athlete: {
        id: 'a1',
        name: 'Sam',
        dob: '1990-01-01',
        sex: 'M',
        timezone: TZ,
        notes: null,
        asthma: false,
        telegram_chat_id: '123',
      },
      goalRace: null,
      tuneupRaces: [],
      pastRace: null,
      injuries: [],
      profileMd: '',
      trainingProfile: {
        athlete_id: 'a1',
        goal_type: 'day_to_day',
        goal_state: 'day_to_day',
        goal_distance: 'keep_fit',
        experience_tier: 'some_training',
        days_per_week: 4,
        long_run_day: 0,
        target_date: null,
        goal_race_id: null,
        created_at: '2026-06-01',
        updated_at: '2026-06-01',
      },
    });
    const out = await renderSystemPrompt('a1', null, { newEndDate: '2026-09-27', blockWeeks: 8 });
    expect(out).toContain('The plan was just extended');
    expect(out).toContain('2026-09-27');
  });
});

describe('easeInContext — mid-week onboarder ease-in signal', () => {
  // A minimal plan shaped to what easeInContext reads: week 1's note + dates,
  // metadata.total_weeks, and weeks.length. Cast through unknown since the rest of
  // the Plan schema is irrelevant to the signal.
  function planFixture(opts: {
    note?: string;
    start: string;
    end: string;
    totalWeeks: number;
  }): Plan {
    const weeks = [
      {
        week_number: 1,
        start_date: opts.start,
        end_date: opts.end,
        coaching_note: opts.note,
        days: [],
      },
    ];
    for (let w = 2; w <= opts.totalWeeks; w++) {
      weeks.push({ week_number: w, start_date: undefined, end_date: undefined, days: [] } as never);
    }
    return {
      metadata: { plan_structure: { total_weeks: opts.totalWeeks } },
      weeks,
    } as unknown as Plan;
  }

  // Week 1 = Mon 2026-06-08 .. Sun 2026-06-14. The renderer's two note variants.
  const REMAINDER_NOTE =
    "Ease-in week. You're starting partway through the week, so the rest of it stays easy. " +
    'Long runs and harder sessions start in week 2, your first full week.';

  const race = {
    id: 'r1',
    name: 'CIM',
    date: '2026-12-06',
    distance_mi: 26.2,
    elevation_ft: 300,
    terrain: 'road',
    target_type: 'finish',
    target_time_sec: null,
    status: 'upcoming',
    created_at: '2026-06-01',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it('active: mid-week onboarder in week 1 → days-left + runway + first-full-week framing', () => {
    const plan = planFixture({
      note: REMAINDER_NOTE,
      start: '2026-06-08',
      end: '2026-06-14',
      totalWeeks: 12,
    });
    const out = easeInContext(plan, '2026-06-11', race); // Thursday, inside week 1
    expect(out).toContain('ease-in first week');
    // Thu→Sun inclusive = 4 days remaining, through the Sunday end.
    expect(out).toContain('Days left in this partial week: 4 (through 2026-06-14)');
    expect(out).toContain('12 weeks to CIM on 2026-12-06');
    expect(out).toContain('Week 2 is their first full week');
    // ask-first guardrail is present
    expect(out).toContain('marathon_training_plan.json');
  });

  it('active: no committed race → week-count runway framing, no race line', () => {
    const plan = planFixture({
      note: REMAINDER_NOTE,
      start: '2026-06-08',
      end: '2026-06-14',
      totalWeeks: 16,
    });
    const out = easeInContext(plan, '2026-06-11', null);
    expect(out).toContain('a 16-week plan');
    expect(out).not.toContain('weeks to');
  });

  it('days-left counts inclusively from today through the Sunday end', () => {
    const plan = planFixture({
      note: REMAINDER_NOTE,
      start: '2026-06-08',
      end: '2026-06-14',
      totalWeeks: 12,
    });
    // Monday onboarder: the whole week remains.
    expect(easeInContext(plan, '2026-06-08', race)).toContain('Days left in this partial week: 7');
    // Sunday onboarder: only the last day.
    expect(easeInContext(plan, '2026-06-14', race)).toContain('Days left in this partial week: 1');
  });

  it('inactive: same athlete past week 1 (today after week-1 end) → empty', () => {
    const plan = planFixture({
      note: REMAINDER_NOTE,
      start: '2026-06-08',
      end: '2026-06-14',
      totalWeeks: 12,
    });
    expect(easeInContext(plan, '2026-06-25', race)).toBe(''); // week 3
  });

  it('inactive: clamped far-race plan whose week 1 is in the future → empty', () => {
    // A clamped plan starts later; today is before week 1, and it carries no ease-in note.
    const plan = planFixture({ start: '2026-07-06', end: '2026-07-12', totalWeeks: 30 });
    expect(easeInContext(plan, '2026-06-11', race)).toBe('');
  });

  it('inactive: week 1 has no ease-in note even if today is inside its dates → empty', () => {
    const plan = planFixture({
      note: 'Base week. Build the aerobic engine.',
      start: '2026-06-08',
      end: '2026-06-14',
      totalWeeks: 12,
    });
    expect(easeInContext(plan, '2026-06-11', race)).toBe('');
  });

  it('inactive: no plan (null/undefined) → empty', () => {
    expect(easeInContext(null, '2026-06-11', race)).toBe('');
    expect(easeInContext(undefined, '2026-06-11', race)).toBe('');
  });

  it('the active block leaves no residual {{placeholders}}', () => {
    const plan = planFixture({
      note: REMAINDER_NOTE,
      start: '2026-06-08',
      end: '2026-06-14',
      totalWeeks: 12,
    });
    const out = easeInContext(plan, '2026-06-11', race);
    expect(out).not.toContain('{{');
    expect(out).not.toContain('}}');
  });
});
