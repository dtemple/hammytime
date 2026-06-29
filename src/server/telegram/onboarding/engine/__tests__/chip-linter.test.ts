// Unit coverage for the §5.3 chip linter (engine/__evals__/assertions.ts). Pure
// and deterministic — pins each of the four §4 corollaries on synthetic transcript
// turns, so the linter itself can't silently regress without the live eval.

import { describe, it, expect } from 'vitest';
import { checkChipPolicy } from '../__evals__/assertions';
import type { DriveResult } from '../__evals__/types';

type Chip = { label: string; data: string };
function coach(body: string, chips: Chip[] = []) {
  return { direction: 'coach' as const, body, chips };
}
function run(...turns: ReturnType<typeof coach>[]): string[] {
  return checkChipPolicy({ transcript: turns } as unknown as DriveResult);
}

const GOAL_TYPE: Chip[] = [
  { label: 'A race', data: 'v3:a race' },
  { label: 'Personal goal with a date', data: 'v3:my own dated goal, not an official race' },
];
const GOAL_DISTANCE: Chip[] = [
  { label: '5K', data: 'v3:5k' },
  { label: '10K', data: 'v3:10k' },
  { label: 'Half', data: 'v3:half' },
  { label: 'Marathon', data: 'v3:marathon' },
];
const EXPERIENCE: Chip[] = [
  { label: 'New to running', data: 'v3:beginner' },
  { label: 'Run for fun', data: 'v3:for_fun' },
  { label: 'Some training', data: 'v3:some_training' },
  { label: 'Experienced', data: 'v3:experienced' },
];
const YES_FIX: Chip[] = [
  { label: 'Looks right', data: 'v3:yes' },
  { label: 'Fix it', data: 'v3:let me fix that' },
];
const INJURY: Chip[] = [{ label: 'Nothing right now', data: 'v3:nothing bothering me right now' }];
const CHECK_BACK: Chip[] = [
  { label: 'In a month', data: 'v3:checkback:1m' },
  { label: 'In 3 months', data: 'v3:checkback:3m' },
  { label: "Don't bother", data: 'v3:checkback:none' },
];
const NEXT_ACTIONS: Chip[] = [
  { label: 'Add to calendar', data: 'next:calendar' },
  { label: 'Adjust the plan', data: 'next:adjust' },
];

describe('chip linter — should PASS (no failures)', () => {
  it('open goal_type ask', () => {
    expect(run(coach('What are you training for — a race, or a personal goal with a date?', GOAL_TYPE))).toEqual([]);
  });
  it('open experience ask', () => {
    expect(run(coach('Looking across all your running — how would you describe yourself as a runner?', EXPERIENCE))).toEqual([]);
  });
  it('yes/no confirm with yes/no chips', () => {
    expect(run(coach("I've got your distance as marathon — that right?", YES_FIX))).toEqual([]);
  });
  it('injury beat', () => {
    expect(run(coach("Anything bothering you right now — or anything you've been managing recently?", INJURY))).toEqual([]);
  });
  it('check-back question with interval chips', () => {
    expect(run(coach('Want me to check back when something might be on the calendar?', CHECK_BACK))).toEqual([]);
  });
  it('terminal next-actions keyboard (non-v3 prefix is out of scope)', () => {
    expect(run(coach("That's your starting plan. A few things you can do now:", NEXT_ACTIONS))).toEqual([]);
  });
  it('imperative ask without a "?" still solicits — distance chips ok', () => {
    // safety-contradiction turn 5: a real ask phrased as an instruction.
    expect(
      run(coach('A half gives us the runway. Go check the site and let me know what you find.', GOAL_DISTANCE)),
    ).toEqual([]);
  });
  it('recap that closes on a statement (no "?") keeps Looks right / Fix it', () => {
    // adventure-mid-month turn 11: model recap ending "…building your plan now."
    expect(
      run(coach('Here\'s what I\'ve got:\n**Goal:** a 20-miler\nGood to go — building your plan now.', YES_FIX)),
    ).toEqual([]);
  });
});

describe('chip linter — should FAIL', () => {
  it('(1) chips on an emoji-only goodbye', () => {
    const f = run(coach('👋😄', GOAL_TYPE));
    expect(f.some((x) => x.includes('non-question'))).toBe(true);
  });
  it('(1) chips on a farewell sign-off', () => {
    const f = run(coach("All good — I'll leave it here. Message me when something lands.", GOAL_TYPE));
    expect(f.some((x) => x.includes('non-question'))).toBe(true);
  });
  it('(2) same-outcome pair (duplicate value)', () => {
    const f = run(
      coach('Anything bothering you right now?', [
        { label: 'Nothing right now', data: 'v3:none' },
        { label: 'Skip', data: 'v3:none' },
      ]),
    );
    expect(f.some((x) => x.includes('same-outcome'))).toBe(true);
  });
  it('(3) option chips on a yes/no confirm', () => {
    const f = run(coach('Strava shows roughly 4 days a week. That about right?', EXPERIENCE));
    expect(f.some((x) => x.includes('option-on-yesno'))).toBe(true);
  });
  it('(4) round-trip: experience labels with a non-coercing value', () => {
    const f = run(
      coach('How would you describe yourself as a runner?', [
        { label: 'New to running', data: 'v3:beginner' },
        { label: 'Run for fun', data: 'v3:intermediate' },
      ]),
    );
    expect(f.some((x) => x.includes('round-trip'))).toBe(true);
  });
});
