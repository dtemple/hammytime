import { describe, it, expect } from 'vitest';
import { checkSafeToPoll } from './polling-guard';

describe('checkSafeToPoll', () => {
  it('refuses to poll when a webhook url is registered (would delete it)', () => {
    const result = checkSafeToPoll('https://www.daybreak.run/api/tg/webhook');
    expect(result.safe).toBe(false);
    expect(result.message).toContain('webhook');
    // Surfaces the actual url so the operator sees what they'd be destroying.
    expect(result.message).toContain('https://www.daybreak.run/api/tg/webhook');
  });

  it('allows polling when no webhook is registered', () => {
    expect(checkSafeToPoll('').safe).toBe(true);
    expect(checkSafeToPoll(undefined).safe).toBe(true);
    expect(checkSafeToPoll(null).safe).toBe(true);
  });
});
