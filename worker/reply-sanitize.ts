// Backstop for a coach-agent failure mode: the model sometimes prefixes its
// athlete-facing message with a planning sentence ("Now I'll write the coaching
// message, then update the files.") that the worker would otherwise forward to
// the athlete verbatim. The prompt forbids it (worker/prompts/coach.md), but the
// model violates it.
//
// Two layers, in order of trust:
//
//  1. `<message>…</message>` extraction (extractCoachMessage). coach.md asks the
//     model to wrap the athlete-facing text in these tags; anything outside is
//     the model's planning and gets discarded. This is the deterministic path —
//     no heuristics, no risk of clipping real content. We take the LAST block so
//     a model that shows an example block and then writes the real one still
//     resolves to the real one.
//
//  2. stripCoachPreamble — the heuristic fallback for when the model omits the
//     tags. It strips a *leading* preamble in two narrow shapes: a `---`-fenced
//     one (the original case) and a fence-less paragraph that explicitly narrates
//     the act of writing/sending the message ("Writing the message now."). Both
//     are leading-only and require a real body after them, so genuine content is
//     never clipped.
//
// sanitizeCoachReply composes the two and is what the worker calls.

const HR_RE = /^\s*-{3,}\s*$/;

// A preamble is at most this many non-blank lines. One or two sentences of
// "Now I'll…" / "Here's the message:" qualify; a real message body does not,
// which is what keeps the strip leading-only.
const MAX_PREAMBLE_LINES = 2;

// A leading paragraph counts as planning narration only when it talks about the
// coach's own act of producing the message — "Now I'll write the coaching
// message", "Writing the message now", "I'll send the post-activity note",
// "Here's the message". It deliberately keys on the first-person act of
// writing/sending a message|note|reply, NOT on any mention of a file: coach.md
// explicitly allows inline file notes ("noted in `race_calendar.md`"), and a
// real coaching line like "I'll note that in your log" must survive. "note" is
// only matched as the message's noun, never as a verb.
const META_NARRATION_RE = new RegExp(
  [
    // "Now I'll write the coaching message", "I'll send the … note"
    "\\b(?:now\\s+)?i'?ll\\s+(?:write|send|draft|compose)\\b[^.\\n]*\\b(?:message|note|reply|response|coaching)\\b",
    // "Writing the message now", "Sending the post-activity note"
    '\\b(?:writing|sending|drafting|composing)\\b[^.\\n]*\\b(?:message|note|reply|response)\\b',
    // "Here's the coaching message", "Here's your note"
    "\\bhere'?s\\s+(?:the|your)\\b[^.\\n]*\\b(?:message|note|reply|response)\\b",
  ].join('|'),
  'i',
);

const MESSAGE_BLOCK_RE = /<message>([\s\S]*?)<\/message>/gi;
const STRAY_TAG_RE = /<\/?message>/gi;

// The worker entry point: deterministic `<message>` extraction first, the
// heuristic preamble strip as fallback. Stray tags are scrubbed on both paths so
// a literal `<message>` can never reach Telegram.
export function sanitizeCoachReply(text: string): string {
  const extracted = extractCoachMessage(text);
  if (extracted) return extracted;
  return stripCoachPreamble(text.replace(STRAY_TAG_RE, ''));
}

// Pull the athlete-facing message out of the last `<message>…</message>` block.
// Returns null when there's no block (so the caller falls back to the heuristic);
// returns the trimmed inner text (stray tags scrubbed) when there is one.
export function extractCoachMessage(text: string): string | null {
  const matches = [...text.matchAll(MESSAGE_BLOCK_RE)];
  if (matches.length === 0) return null;
  const inner = matches[matches.length - 1]?.[1] ?? '';
  return inner.replace(STRAY_TAG_RE, '').trim();
}

export function stripCoachPreamble(text: string): string {
  const lines = text.split('\n');

  // Layer 1 — fenced preamble: a short lead-in, a `---`, then the real message.
  // coach.md never emits a legitimate `---`, so a fence near the top is an
  // artifact. Only strip when there's real content after it.
  const firstFence = lines.findIndex((l) => HR_RE.test(l));
  if (firstFence !== -1) {
    const before = lines.slice(0, firstFence).filter((l) => l.trim() !== '');
    const after = lines.slice(firstFence + 1).join('\n');
    // A short line followed by a *trailing* fence ("The real message.\n\n---")
    // is structurally identical to a one-line preamble with an empty body — so
    // when nothing follows the fence we keep the line and treat the fence as
    // trailing. This is the fence-only safety guarantee: never clip real content.
    if (before.length <= MAX_PREAMBLE_LINES && after.trim() !== '') {
      return stripTrailingFence(after).trim();
    }
  }

  // Layer 2 — fence-less preamble: a short leading paragraph that narrates the
  // act of writing/sending the message, blank-line-separated from a real body.
  const body = stripLeadingMetaParagraph(text);
  if (body !== null) return stripTrailingFence(body).trim();

  return stripTrailingFence(text).trim();
}

// If the first blank-line-delimited paragraph is a short act-of-writing
// narration ("Writing the message now.") and a non-empty body follows it, return
// the body. Otherwise null (leave the text alone). Requiring a blank-line
// separator and a non-empty body is what bounds this: a single-paragraph reply
// (no blank line) is never touched, so we can't swallow a one-paragraph message.
function stripLeadingMetaParagraph(text: string): string | null {
  const lines = text.split('\n');
  const firstBlank = lines.findIndex((l) => l.trim() === '');
  if (firstBlank === -1) return null;

  const leading = lines.slice(0, firstBlank).filter((l) => l.trim() !== '');
  if (leading.length === 0 || leading.length > MAX_PREAMBLE_LINES) return null;

  const bodyText = lines.slice(firstBlank + 1).join('\n');
  if (bodyText.trim() === '') return null;

  if (!META_NARRATION_RE.test(leading.join(' '))) return null;
  return bodyText;
}

// Drop a trailing lone horizontal rule — the closing half of a model that wrapped
// its whole message in `---` fences.
function stripTrailingFence(text: string): string {
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end--;
  if (end > 0 && HR_RE.test(lines[end - 1] ?? '')) {
    return lines.slice(0, end - 1).join('\n');
  }
  return text;
}
