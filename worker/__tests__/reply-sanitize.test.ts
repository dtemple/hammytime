import { describe, it, expect } from 'vitest';
import {
  stripCoachPreamble,
  extractCoachMessage,
  sanitizeCoachReply,
} from '../reply-sanitize';

describe('stripCoachPreamble — fenced preamble (original behavior)', () => {
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

describe('stripCoachPreamble — fence-less preamble (real A/B-eval captures)', () => {
  it('strips "Perfect. Now I\'ll write the coaching message:" (Haiku, daily)', () => {
    const input =
      "Perfect. Now I'll write the coaching message:\n\nEasy 4 today, conversational. How's the calf?";
    expect(stripCoachPreamble(input)).toBe(
      "Easy 4 today, conversational. How's the calf?",
    );
  });

  it('strips "Perfect. Now I\'ll send the post-activity note." (Haiku, post-activity)', () => {
    const input =
      "Perfect. Now I'll send the post-activity note.\n\nSaw your 3.75-mile easy run yesterday morning — nice one.";
    expect(stripCoachPreamble(input)).toBe(
      'Saw your 3.75-mile easy run yesterday morning — nice one.',
    );
  });

  it('strips a file-state accounting lead ending in "Writing the message now." (Sonnet, daily)', () => {
    const input =
      'The checkin log already has today\'s entry, Strava is current (tempo confirmed yesterday), and no new facts to file. Writing the message now.\n\nUpper body day — 60 minutes, no legs.';
    expect(stripCoachPreamble(input)).toBe('Upper body day — 60 minutes, no legs.');
  });

  it('strips a file-state accounting lead ending in "I\'ll write the message now." (Sonnet, daily)', () => {
    const input =
      "The checkin log already has a 6/24 entry from the previous run. Files are current — no new facts to write. I'll write the message now.\n\nRest day today. Tomorrow is the 8.5.";
    expect(stripCoachPreamble(input)).toBe('Rest day today. Tomorrow is the 8.5.');
  });

  it('does NOT strip a real opening that mentions a file note inline', () => {
    // coach.md allows inline file notes ("noted in race_calendar.md"). That's a
    // real message paragraph, not act-of-writing narration, so it must survive.
    const input =
      'Logged that Boston is April 20 — noted in race_calendar.md.\n\nThat gives us 18 weeks. Plenty of runway.';
    expect(stripCoachPreamble(input)).toBe(input);
  });

  it('does NOT strip a real opening that tells the athlete to message back', () => {
    // Second-person "send me a message" is coaching, not the coach narrating its
    // own act of writing — keep it.
    const input =
      'Send me a message after the long run so I know how it went.\n\nEasy shakeout tomorrow either way.';
    expect(stripCoachPreamble(input)).toBe(input);
  });

  it('does NOT swallow a single-paragraph reply (no blank-line body)', () => {
    const input = "Now I'll write the message: easy 4 today.";
    expect(stripCoachPreamble(input)).toBe(input);
  });

  it('keeps a multi-line meta lead that exceeds the preamble cap', () => {
    const input =
      "Files are current.\nNothing new to log.\nStrava is fresh.\nI'll write the message now.\n\nEasy 4 today.";
    expect(stripCoachPreamble(input)).toBe(input);
  });
});

describe('extractCoachMessage', () => {
  it('returns the inner text of a <message> block', () => {
    expect(extractCoachMessage('<message>\nEasy 4 today.\n</message>')).toBe(
      'Easy 4 today.',
    );
  });

  it('discards planning above the opening tag', () => {
    const input =
      "Files are current, no new facts. Now I'll write it.\n\n<message>\nRest day today. How's the calf?\n</message>";
    expect(extractCoachMessage(input)).toBe("Rest day today. How's the calf?");
  });

  it('takes the last block when more than one is present', () => {
    const input =
      '<message>example skeleton</message>\nActually let me redo that.\n<message>Real message: easy 4 today.</message>';
    expect(extractCoachMessage(input)).toBe('Real message: easy 4 today.');
  });

  it('preserves intentional newlines and formatting inside the block', () => {
    const input = '<message>Line one.\n\nLine two with **bold**.</message>';
    expect(extractCoachMessage(input)).toBe('Line one.\n\nLine two with **bold**.');
  });

  it('returns null when there is no block', () => {
    expect(extractCoachMessage('Just a plain message, no tags.')).toBeNull();
  });
});

describe('sanitizeCoachReply — extraction first, heuristic fallback', () => {
  it('extracts the <message> block when present', () => {
    const input = "I'll write it now.\n\n<message>\nEasy 4 today.\n</message>";
    expect(sanitizeCoachReply(input)).toBe('Easy 4 today.');
  });

  it('falls back to the preamble strip when no tags are present', () => {
    const input =
      "Perfect. Now I'll write the coaching message:\n\nEasy 4 today, conversational.";
    expect(sanitizeCoachReply(input)).toBe('Easy 4 today, conversational.');
  });

  it('scrubs a stray closing tag the model leaked without a block', () => {
    expect(sanitizeCoachReply('Easy 4 today.</message>')).toBe('Easy 4 today.');
  });

  it('leaves a clean tag-less message untouched', () => {
    const input = 'Easy 4 today, conversational. How did the knee feel?';
    expect(sanitizeCoachReply(input)).toBe(input);
  });
});
