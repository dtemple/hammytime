import { describe, it, expect } from 'vitest';
import { parsePrehabMarkdown, prehabPageBlocks, type Block } from './prehab-markdown';

// The corpus lookup is intentionally NOT mocked — linkification tests assert
// against real worker/knowledge/exercises.md entries (same convention as
// worker/__tests__/send.test.ts).

const SKELETON = `# Prehab routine — Sam

## Standing routine
- Dead bug — 3×10 each side — why: trunk control under fatigue
- Single-leg calf raises — 3×12/side — why: Achilles load tolerance
- Backflip burpees — 2×5 — why: not a real corpus entry

## Schedule
- Anchor: rest day + strength days
- This week: Monday, Thursday

## Revision log
- 2026-06-09 — authored. Consolidated from recent check-ins.
`;

function headings(blocks: Block[]): string[] {
  return blocks.filter((b) => b.kind === 'heading').map((b) => b.text);
}

describe('parsePrehabMarkdown', () => {
  it('parses the skeleton into headings, bullets, and paragraphs', () => {
    const blocks = parsePrehabMarkdown(SKELETON);
    expect(headings(blocks)).toEqual([
      'Prehab routine — Sam',
      'Standing routine',
      'Schedule',
      'Revision log',
    ]);
    const bulletBlocks = blocks.filter((b) => b.kind === 'bullets');
    expect(bulletBlocks).toHaveLength(3);
    expect(bulletBlocks[0]!.items).toHaveLength(3);
  });

  it('links a routine bullet whose exercise name matches the corpus', () => {
    const blocks = parsePrehabMarkdown(SKELETON);
    const routine = blocks.filter((b) => b.kind === 'bullets')[0]!;
    const deadBug = routine.items[0]!;
    expect(deadBug[0]).toEqual({
      kind: 'link',
      text: 'Dead bug',
      href: 'https://www.youtube.com/watch?v=BZYaCzbP09M',
    });
    expect(deadBug[1]!.kind).toBe('text');
  });

  it('links a plural exercise name via the strip-s retry', () => {
    const blocks = parsePrehabMarkdown(SKELETON);
    const routine = blocks.filter((b) => b.kind === 'bullets')[0]!;
    const calfRaises = routine.items[1]!;
    expect(calfRaises[0]).toEqual({
      kind: 'link',
      text: 'Single-leg calf raises',
      href: 'https://e3rehab.com/calves/',
    });
  });

  it('leaves an unknown exercise as plain text', () => {
    const blocks = parsePrehabMarkdown(SKELETON);
    const routine = blocks.filter((b) => b.kind === 'bullets')[0]!;
    expect(routine.items[2]!.every((seg) => seg.kind === 'text')).toBe(true);
  });

  it('does not linkify bullets outside the routine section', () => {
    const md = '## Schedule\n- Dead bug — also on Mondays\n';
    const blocks = parsePrehabMarkdown(md);
    const bullets = blocks.find((b) => b.kind === 'bullets')!;
    expect(bullets.items[0]!.every((seg) => seg.kind === 'text')).toBe(true);
  });

  it('links a bolded exercise name with the asterisks stripped', () => {
    const md = '## Standing routine\n- **Dead bug** — 3×10\n';
    const blocks = parsePrehabMarkdown(md);
    const bullets = blocks.find((b) => b.kind === 'bullets')!;
    expect(bullets.items[0]![0]).toMatchObject({ kind: 'link', text: 'Dead bug' });
  });

  it('resolves a chat-style [label](slug) token by slug (real prod file shape)', () => {
    const md =
      '## Standing routine\n- [Single-leg glute bridges](single-leg-glute-bridge) — 3×10/leg — **why:** hamstring tendon\n';
    const blocks = parsePrehabMarkdown(md);
    const item = blocks.find((b) => b.kind === 'bullets')!.items[0]!;
    expect(item[0]).toMatchObject({ kind: 'link', text: 'Single-leg glute bridges' });
    expect((item[0] as { href: string }).href).toMatch(/^https:\/\//);
    expect(item.some((s) => s.kind === 'bold' && s.text === 'why:')).toBe(true);
    expect(item.map((s) => s.text).join('')).not.toContain('](');
  });

  it('collapses an unknown [label](slug) token to its plain label', () => {
    const blocks = parsePrehabMarkdown('See [your prehab routine](prehab-routine) for the rest.');
    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      segments: [
        { kind: 'text', text: 'See ' },
        { kind: 'text', text: 'your prehab routine' },
        { kind: 'text', text: ' for the rest.' },
      ],
    });
  });

  it('flattens a link token inside bold to its bold label', () => {
    const blocks = parsePrehabMarkdown('**[Dead bug](dead-bug)** — 3×10');
    expect(blocks[0]!.kind).toBe('paragraph');
    const segs = (blocks[0] as { segments: { kind: string; text: string }[] }).segments;
    expect(segs[0]).toEqual({ kind: 'bold', text: 'Dead bug' });
  });

  it('parses **bold** into bold segments in prose', () => {
    const blocks = parsePrehabMarkdown('Do this **every** time.');
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        segments: [
          { kind: 'text', text: 'Do this ' },
          { kind: 'bold', text: 'every' },
          { kind: 'text', text: ' time.' },
        ],
      },
    ]);
  });

  it('keeps hostile input as text segments — no hrefs except corpus sources', () => {
    const md = [
      '## Standing routine',
      '- <script>alert(1)</script> — 3×10 — why: nope',
      '<img src=x onerror=alert(1)>',
      '[click me](javascript:alert(1))',
    ].join('\n');
    const blocks = parsePrehabMarkdown(md);
    const segments = blocks.flatMap((b) =>
      b.kind === 'bullets' ? b.items.flat() : b.kind === 'paragraph' ? b.segments : [],
    );
    expect(segments.some((s) => s.kind === 'link')).toBe(false);
    expect(segments.map((s) => s.text).join(' ')).toContain('<script>alert(1)</script>');
  });

  it('degrades drifted markdown (h3, numbered lists, tables) to paragraphs without throwing', () => {
    const md = '### Deep heading\n1. numbered item\n| col | col |\n';
    const blocks = parsePrehabMarkdown(md);
    expect(blocks).toHaveLength(3);
    expect(blocks.every((b) => b.kind === 'paragraph')).toBe(true);
  });

  it('returns [] for an empty string', () => {
    expect(parsePrehabMarkdown('')).toEqual([]);
  });
});

describe('prehabPageBlocks', () => {
  it('drops the h1 and the Revision log section', () => {
    const blocks = prehabPageBlocks(SKELETON);
    expect(headings(blocks)).toEqual(['Standing routine', 'Schedule']);
    const text = JSON.stringify(blocks);
    expect(text).not.toContain('Prehab routine — Sam');
    expect(text).not.toContain('authored');
  });

  it('drops the Revision log under heading-case drift', () => {
    const md = '## Standing routine\n- a thing\n\n## Revision Log\n- 2026-06-09 — authored.\n';
    const blocks = prehabPageBlocks(md);
    expect(headings(blocks)).toEqual(['Standing routine']);
    expect(JSON.stringify(blocks)).not.toContain('authored');
  });

  it('resumes after the revision log when another section follows', () => {
    const md = '## Revision log\n- old note\n\n## Schedule\n- This week: Monday\n';
    const blocks = prehabPageBlocks(md);
    expect(headings(blocks)).toEqual(['Schedule']);
    expect(JSON.stringify(blocks)).toContain('This week: Monday');
  });
});
