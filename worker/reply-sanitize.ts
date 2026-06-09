// Backstop for a coach-agent failure mode: the model sometimes prefixes its
// athlete-facing message with a planning sentence ("Now I'll write the coaching
// message, then update the files.") and a `---` fence before the real text. The
// prompt forbids both (worker/prompts/coach.md), but the model violates it, and
// the worker forwards result.result verbatim. coach.md never emits a legitimate
// `---`, so a fence near the top is always an artifact we can safely cut.
//
// Scope is deliberately narrow (fence-only): we strip a *leading* `---`-fenced
// preamble and a *trailing* lone fence. A `---` that follows a real message body
// is left alone, so we never clip genuine content.

const HR_RE = /^\s*-{3,}\s*$/;

// A preamble is at most this many non-blank lines before the fence. One or two
// sentences of "Now I'll…" / "Here's the message:" qualify; a real message body
// does not, which is what keeps the strip leading-only.
const MAX_PREAMBLE_LINES = 2;

export function stripCoachPreamble(text: string): string {
  const lines = text.split('\n');

  const firstFence = lines.findIndex((l) => HR_RE.test(l));
  if (firstFence !== -1) {
    const before = lines.slice(0, firstFence).filter((l) => l.trim() !== '');
    const after = lines.slice(firstFence + 1).join('\n');
    // Only strip a leading preamble when there's real content after the fence.
    // A short line followed by a *trailing* fence ("The real message.\n\n---")
    // is structurally identical to a one-line preamble with an empty body —
    // so when nothing follows the fence we keep the line and treat the fence as
    // trailing. This is the fence-only safety guarantee: never clip real content.
    if (before.length <= MAX_PREAMBLE_LINES && after.trim() !== '') {
      return stripTrailingFence(after).trim();
    }
  }

  return stripTrailingFence(text).trim();
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
