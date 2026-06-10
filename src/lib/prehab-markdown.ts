// Parses an agent-authored prehab_program.md into typed blocks for the public
// prehab routine page (/prehab/[token]). Same regex-line-pass style as
// exercise-library.ts — no markdown library.
//
// The output is data, never HTML: the page renders segments as React children,
// so hostile or drifted agent markdown can only ever become visible text. The
// only hrefs that can appear are `source` URLs from worker/knowledge/
// exercises.md, attached when a routine bullet's leading exercise name matches
// a corpus entry. Unknown constructs (###+ headings, tables, numbered lists,
// raw URLs) degrade to plain paragraphs; the parser never throws.

import { resolveExercise } from '@/lib/exercise-library';

export type InlineSegment =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block =
  | { kind: 'heading'; level: 1 | 2; text: string }
  | { kind: 'bullets'; items: InlineSegment[][] }
  | { kind: 'paragraph'; segments: InlineSegment[] };

const BOLD_RE = /\*\*(.+?)\*\*/g;

// First " — " (em/en dash, or spaced hyphen) — splits the exercise name off a
// skeleton bullet like `<exercise> — <dose> — why: <one line>`.
const SEP_RE = /\s*[—–]\s*|\s+-\s+/;

// The coach writes chat-style `[label](slug)` tokens into the program file too
// (verified against a real prod file). Same semantics as worker/send.ts: the
// slug is id-shaped (so a URL or javascript: scheme can never match), a corpus
// hit links to its `source`, a miss collapses to the plain label.
const LINK_TOKEN_RE = /\[([^\]]+)\]\(([a-z0-9-]+)\)/;
const INLINE_RE = new RegExp(`${BOLD_RE.source}|${LINK_TOKEN_RE.source}`, 'g');

function linkOrLabel(label: string, slug: string): InlineSegment {
  const entry = resolveExercise({ slug });
  return entry ? { kind: 'link', text: label, href: entry.source } : { kind: 'text', text: label };
}

function inlineSegments(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index! > last) segments.push({ kind: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) {
      // Bold. A link token inside bold flattens to its label — segments don't
      // nest, and a bold plain name beats literal bracket noise.
      segments.push({
        kind: 'bold',
        text: m[1].replace(new RegExp(LINK_TOKEN_RE.source, 'g'), '$1'),
      });
    } else {
      segments.push(linkOrLabel(m[2]!, m[3]!));
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}

// Name-fallback lookup with a plural second chance: routine bullets usually
// say "eccentric heel drops" while the corpus id is singular, and
// normalizeExerciseName doesn't canonicalize plurals (see exercise-library.ts).
function resolveByName(name: string) {
  const direct = resolveExercise({ name });
  if (direct) return direct;
  const singular = name.replace(/s\s*$/i, '');
  return singular !== name ? resolveExercise({ name: singular }) : undefined;
}

// A routine bullet's leading exercise name becomes a corpus link when it
// resolves; everything else stays text. Best-effort by design — a miss is
// cosmetic, never an error.
function bulletSegments(item: string, inRoutineSection: boolean): InlineSegment[] {
  if (!inRoutineSection) return inlineSegments(item);
  const sep = SEP_RE.exec(item);
  if (!sep || sep.index === 0) return inlineSegments(item);

  const lead = item.slice(0, sep.index).replace(/\*\*/g, '').trim();
  const entry = lead ? resolveByName(lead) : undefined;
  if (!entry) return inlineSegments(item);

  return [
    { kind: 'link', text: lead, href: entry.source },
    ...inlineSegments(item.slice(sep.index)),
  ];
}

export function parsePrehabMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  let bullets: InlineSegment[][] | null = null;
  let inRoutineSection = false;

  const flushBullets = () => {
    if (bullets && bullets.length > 0) blocks.push({ kind: 'bullets', items: bullets });
    bullets = null;
  };

  for (const rawLine of md.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      flushBullets();
      continue;
    }

    const h = /^(#{1,2})\s+(.*)$/.exec(line);
    if (h) {
      flushBullets();
      const level = h[1]!.length as 1 | 2;
      if (level === 2) inRoutineSection = /standing|routine/i.test(h[2]!);
      blocks.push({ kind: 'heading', level, text: h[2]! });
      continue;
    }

    const b = /^-\s+(.*)$/.exec(line);
    if (b) {
      bullets ??= [];
      bullets.push(bulletSegments(b[1]!, inRoutineSection));
      continue;
    }

    flushBullets();
    blocks.push({ kind: 'paragraph', segments: inlineSegments(line) });
  }
  flushBullets();
  return blocks;
}

/**
 * What the page renders: the parsed file minus its h1 (the page has its own
 * title and greeting) and minus the Revision log section (a coach-facing
 * changelog — the page shows "Last updated" from memory_files.updated_at
 * instead).
 */
export function prehabPageBlocks(md: string): Block[] {
  const blocks = parsePrehabMarkdown(md);
  const out: Block[] = [];
  let dropping = false;
  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (block.level === 1) continue;
      dropping = /revision log/i.test(block.text);
      if (dropping) continue;
    }
    if (!dropping) out.push(block);
  }
  return out;
}
