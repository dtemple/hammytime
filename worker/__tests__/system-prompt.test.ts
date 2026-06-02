import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { safetyCapsBlock } from '../system-prompt';
import { DRAFT_SAFETY_CAPS } from '@/lib/plan-templates/caps';

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
