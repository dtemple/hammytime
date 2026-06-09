import { describe, it, expect } from 'vitest';
import { stripCoachPreamble } from '../reply-sanitize';

describe('stripCoachPreamble', () => {
  it('strips a leading narration + fence preamble', () => {
    const input =
      "Now I'll write the coaching message, then update the files.\n\n---\n\nEasy 4.5 miles today — nothing changes.";
    expect(stripCoachPreamble(input)).toBe(
      'Easy 4.5 miles today — nothing changes.',
    );
  });

  it('strips a "here\'s the coaching message" preamble', () => {
    const input =
      "Good shape. Here's the coaching message:\n\n---\n\nWeek 1, Thursday — on track.";
    expect(stripCoachPreamble(input)).toBe('Week 1, Thursday — on track.');
  });

  it('leaves a normal multi-paragraph message untouched', () => {
    const input =
      'Easy 4.5 today, conversational pace.\n\nPrehab before you go: calf raises.\n\nHow did the knee feel?';
    expect(stripCoachPreamble(input)).toBe(input);
  });

  it('does not clip a real message that contains a --- after its body', () => {
    const input =
      'Today is your rest day.\nKeep it easy.\nThree days of work this week.\n\n---\n\nStill standing.';
    // Preamble before the fence is 3 non-blank lines — too long to be a preamble,
    // so the leading strip is skipped and only a trailing fence would be cut.
    expect(stripCoachPreamble(input)).toBe(input);
  });

  it('unwraps a message fenced on both sides', () => {
    expect(stripCoachPreamble('---\n\nMessage\n\n---')).toBe('Message');
  });

  it('keeps a single line + trailing fence (fence-only cannot tell it from a preamble)', () => {
    // Documents the accepted fence-only limitation: a bare narration line with a
    // trailing fence and no body is indistinguishable from a real one-line
    // message, so we keep it (only the trailing fence is dropped) rather than
    // risk clipping genuine content. This leak is mitigated by the prompt, not here.
    expect(stripCoachPreamble("Now I'll update the checkin log.\n\n---\n")).toBe(
      "Now I'll update the checkin log.",
    );
  });

  it('strips a trailing lone fence with no leading preamble', () => {
    expect(stripCoachPreamble('The real message.\n\n---')).toBe('The real message.');
  });
});
