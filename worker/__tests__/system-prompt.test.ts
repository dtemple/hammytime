import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPrompt, safetyCapsBlock } from '../system-prompt';
import { DRAFT_SAFETY_CAPS } from '@/lib/plan-templates/caps';

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
