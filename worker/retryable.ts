// Classifies an agent-run failure as transient (worth a queue retry) vs terminal.
//
// The Agent SDK surfaces an Anthropic API error either as an error result whose
// text reads "Claude Code returned an error result: API Error: 529 Overloaded …"
// or as a thrown error with a similar message. A transient overload / rate limit
// / 5xx should ride the job_queue backoff (worker/poll.ts) instead of dead-ending
// on the soft fallback. Anything unrecognized stays terminal — better to surface
// a stuck run than to loop on a real bug.

const RETRYABLE_PATTERNS: RegExp[] = [
  /overloaded/i,
  /rate.?limit/i,
  // Anthropic transient HTTP statuses. 529 = overloaded, 429 = rate limit,
  // 500/502/503/504 = server-side hiccups. Matched word-bounded so a stray
  // digit run in an unrelated message doesn't trip it.
  /\b(429|500|502|503|504|529)\b/,
  // Network-level transients from the SDK's HTTP client.
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i,
  /\btimed? ?out\b/i,
];

export function isRetryableAgentError(message: string | null | undefined): boolean {
  if (!message) return false;
  return RETRYABLE_PATTERNS.some((re) => re.test(message));
}
