import { describe, it, expect } from 'vitest';
import { isRetryableAgentError } from '../retryable';

describe('isRetryableAgentError', () => {
  it('matches the Anthropic overload error the SDK surfaces', () => {
    expect(
      isRetryableAgentError(
        'Claude Code returned an error result: API Error: 529 Overloaded. This is a server-side issue.',
      ),
    ).toBe(true);
  });

  it('matches rate limits, 5xx, and network transients', () => {
    expect(isRetryableAgentError('agent run ended with error: API Error: 429 rate_limit')).toBe(true);
    expect(isRetryableAgentError('API Error: 503 Service Unavailable')).toBe(true);
    expect(isRetryableAgentError('API Error: 500 Internal Server Error')).toBe(true);
    expect(isRetryableAgentError('connect ECONNRESET')).toBe(true);
    expect(isRetryableAgentError('socket hang up')).toBe(true);
    expect(isRetryableAgentError('request timed out')).toBe(true);
  });

  it('treats budget stops and unknown errors as terminal', () => {
    expect(isRetryableAgentError('agent run ended with error_max_budget_usd')).toBe(false);
    expect(isRetryableAgentError('binary spawn failed')).toBe(false);
    expect(isRetryableAgentError('stream died mid-run')).toBe(false);
    expect(isRetryableAgentError('')).toBe(false);
    expect(isRetryableAgentError(null)).toBe(false);
    expect(isRetryableAgentError(undefined)).toBe(false);
  });
});
