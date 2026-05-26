// Verbatim question wording from the personal coach's CLAUDE.md.
export const READINESS_PROMPT =
  "How ready do you feel to train today (1–10)? [1–2 = shouldn't run, 5–6 = normal, 9–10 = race-ready]";

export const SORENESS_PROMPT =
  "Soreness 1–10? Optionally name a body part (e.g. 'left hamstring').";

export const NOTE_PROMPT = "One-line note (optional)? Reply 'skip' to skip.";

export const CONCERNING_LINE =
  "Worth a closer look — want to talk it through?";

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

type ParseOk<T> = { ok: true; value: T };
type ParseErr = { ok: false; error: string };
type ParseResult<T> = ParseOk<T> | ParseErr;

function parseIntInRange(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  return n >= min && n <= max ? n : null;
}

/**
 * Parses the readiness question reply.
 * Accepts integers 1–10. Rejects anything else.
 */
export function parseReadiness(text: string): ParseResult<number> {
  const n = parseIntInRange(text, 1, 10);
  if (n === null) {
    return { ok: false, error: "Reply with a number from 1 to 10." };
  }
  return { ok: true, value: n };
}

/**
 * Parses the soreness question reply.
 * Format: "<int>" or "<int> <body_part>".
 * Body part is stored as trimmed raw text; no canonical-list normalization.
 */
export function parseSoreness(
  text: string
): ParseResult<{ score: number; body_part: string | null }> {
  const trimmed = text.trim();
  // Match a leading integer, then optional whitespace + rest-of-string.
  const match = trimmed.match(/^(\d+)(?:\s+(.+))?$/);
  if (!match) {
    return {
      ok: false,
      error: "Reply with a number from 1 to 10, optionally followed by a body part.",
    };
  }
  const score = parseInt(match[1]!, 10);
  if (score < 1 || score > 10) {
    return {
      ok: false,
      error: "Reply with a number from 1 to 10, optionally followed by a body part.",
    };
  }
  const rawBodyPart = match[2]?.trim() ?? null;
  // Strip leading dashes, em-dashes, and punctuation that sometimes appear
  // when athletes copy–paste or type "7 — left hamstring".
  const body_part = rawBodyPart
    ? rawBodyPart.replace(/^[-–—,\s]+/, "").trim() || null
    : null;
  return { ok: true, value: { score, body_part } };
}

/**
 * Parses the note question reply. Always succeeds.
 * Returns null for skip/none/empty; trimmed text (≤500 chars) otherwise.
 */
export function parseNote(text: string): ParseResult<string | null> {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed || trimmed === "skip" || trimmed === "none" || trimmed === "—") {
    return { ok: true, value: null };
  }
  const raw = text.trim();
  return { ok: true, value: raw.slice(0, 500) };
}

/**
 * Returns true if the wellness values cross a concerning threshold.
 * Flag wording is the CONCERNING_LINE constant above.
 */
export function isConcerning(
  readiness: number,
  soreness: number,
  body_part: string | null
): boolean {
  if (readiness <= 4) return true;
  if (soreness >= 6 && body_part !== null) return true;
  if (soreness >= 7 && body_part === null) return true;
  return false;
}
