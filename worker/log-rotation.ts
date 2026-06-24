// Deterministic, worker-owned rotation for date-delimited log memory files.
//
// checkin_log.md grows unbounded — the coach appends an entry every run and reads
// the whole file back, so its tokens creep up forever. This splits an over-cap log
// into a recent working slice (what the agent reads + appends to) and an archive of
// older entries, by entry *date* rather than by line or position. It's pure so the
// caller (hydrate) owns disk I/O and persistence; only checkin_log.md is wired today
// (worker/folder.ts), but the shape is generic so wellness_log/injury_log could reuse it.

// An entry begins at a markdown date header like `## 2026-06-24 — …`. Entries are
// multi-line blocks (Type/Status/Prehab/Follow-ups), so we never split on newlines.
const ENTRY_HEADER = /^#{1,3}\s+(\d{4}-\d{2}-\d{2})/;

type Entry = { date: string; text: string };

// Split content into the preamble (everything before the first dated entry, e.g. the
// `# Check-in Log` title) and the ordered list of dated entries. Lines that don't open
// a new entry attach to the current one. Text before the first header is preamble.
function parse(content: string): { preamble: string; entries: Entry[] } {
  const lines = content.split('\n');
  const preambleLines: string[] = [];
  const entries: Entry[] = [];
  let current: Entry | null = null;

  for (const line of lines) {
    const m = line.match(ENTRY_HEADER);
    if (m) {
      current = { date: m[1]!, text: line };
      entries.push(current);
    } else if (current) {
      current.text += '\n' + line;
    } else {
      preambleLines.push(line);
    }
  }

  return { preamble: preambleLines.join('\n'), entries };
}

/**
 * Splits an over-cap log into a recent working slice and the older tail to archive,
 * keeping entries from the most recent `keepDates` distinct dates. Returns `null`
 * (no rotation) when the log is under `triggerChars`, has no datable entries, or
 * has nothing old enough to move — so a small or unparseable log is never disturbed
 * and the working slice is never emptied.
 *
 * `archived` is *only* the moved entries; the caller concatenates it onto whatever
 * archive already exists. Original order is preserved on both sides.
 */
export function rotateLogByDate(
  content: string,
  opts: { keepDates: number; triggerChars: number },
): { working: string; archived: string } | null {
  if (content.length <= opts.triggerChars) return null;

  const { preamble, entries } = parse(content);
  if (entries.length === 0) return null;

  // Most-recent `keepDates` distinct dates, by calendar date (ISO sorts lexically),
  // independent of whether the file is newest-at-top or newest-at-bottom.
  const distinct = [...new Set(entries.map((e) => e.date))].sort();
  if (distinct.length <= opts.keepDates) return null; // nothing old enough to move
  const keep = new Set(distinct.slice(-opts.keepDates));

  const kept: string[] = [];
  const moved: string[] = [];
  for (const e of entries) (keep.has(e.date) ? kept : moved).push(e.text);

  if (kept.length === 0 || moved.length === 0) return null;

  const working = preamble ? preamble + '\n' + kept.join('\n') : kept.join('\n');
  return { working, archived: moved.join('\n') };
}
