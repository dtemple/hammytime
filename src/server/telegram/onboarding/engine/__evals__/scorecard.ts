// V4-W6 — the scorecard. Renders a git/model-stamped markdown report: per-fixture
// pass/fail, the full captured transcripts, total Sonnet spend, cache hit rate,
// and a diff against the previous run (regressions surfaced). Reuses
// ab-model-eval.ts's report/cost shape as a reference, not its code.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ONBOARDING_MODEL } from '../extract-and-advance';
import type { DriveResult } from './types';

export interface FixtureScore {
  name: string;
  pass: boolean;
  knownFlaky?: string;
  failures: string[];
  outcome: string;
  costUsd: number;
  voice?: { score: number; note: string };
}

export interface Scorecard {
  scores: FixtureScore[];
  totalCost: number;
  cacheHitRate: number;
  generatedAt: string;
  model: string;
  gitRev: string;
}

const PREV_PATH = () => path.join(process.cwd(), 'onboarding-eval-previous.json');

function gitRev(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function scoreResult(result: DriveResult): FixtureScore {
  return {
    name: result.fixture.name,
    pass: result.failures.length === 0,
    knownFlaky: result.fixture.knownFlaky,
    failures: result.failures,
    outcome: result.outcome,
    costUsd: result.costUsd,
    voice: result.voice,
  };
}

export function buildScorecard(results: DriveResult[]): Scorecard {
  const scores = results.map(scoreResult);
  const totalCost = results.reduce((a, r) => a + r.costUsd, 0);
  const reads = results.reduce((a, r) => a + r.cacheReadTokens, 0);
  const writes = results.reduce((a, r) => a + r.cacheCreationTokens, 0);
  const cacheHitRate = reads + writes > 0 ? reads / (reads + writes) : 0;
  return {
    scores,
    totalCost,
    cacheHitRate,
    generatedAt: new Date().toISOString(),
    model: ONBOARDING_MODEL,
    gitRev: gitRev(),
  };
}

interface PrevSnapshot {
  scores: Array<{ name: string; pass: boolean }>;
}

function loadPrev(): PrevSnapshot | null {
  const p = PREV_PATH();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PrevSnapshot;
  } catch {
    return null;
  }
}

function diffSection(card: Scorecard, prev: PrevSnapshot | null): string {
  if (!prev) return '_No previous run to diff against._';
  const prevMap = new Map(prev.scores.map((s) => [s.name, s.pass]));
  const regressed: string[] = [];
  const fixed: string[] = [];
  const added: string[] = [];
  for (const s of card.scores) {
    if (!prevMap.has(s.name)) {
      added.push(s.name);
      continue;
    }
    const was = prevMap.get(s.name)!;
    if (was && !s.pass) regressed.push(s.name);
    if (!was && s.pass) fixed.push(s.name);
  }
  const lines: string[] = [];
  lines.push(regressed.length ? `**Regressions:** ${regressed.join(', ')}` : '**Regressions:** none');
  if (fixed.length) lines.push(`Newly passing: ${fixed.join(', ')}`);
  if (added.length) lines.push(`New fixtures: ${added.join(', ')}`);
  return lines.join('\n\n');
}

function transcriptBlock(result: DriveResult): string {
  return result.transcript
    .map((t) => {
      const who = t.direction === 'athlete' ? 'Athlete' : 'Coach';
      const chips = t.chips?.length ? `   [chips: ${t.chips.map((c) => c.label).join(' | ')}]` : '';
      return `${who}: ${t.body}${chips}`;
    })
    .join('\n');
}

export function renderScorecard(card: Scorecard, results: DriveResult[]): string {
  const prev = loadPrev();
  const passCount = card.scores.filter((s) => s.pass).length;
  const gateScores = card.scores.filter((s) => !s.knownFlaky);
  const gatePass = gateScores.every((s) => s.pass);
  const hasVoice = card.scores.some((s) => s.voice);

  const lines: string[] = [];
  lines.push('# Onboarding eval — V4-W6');
  lines.push('');
  lines.push(`- Generated: ${card.generatedAt}`);
  lines.push(`- Model: \`${card.model}\` @ \`${card.gitRev}\``);
  lines.push(`- Gate: **${gatePass ? 'PASS' : 'FAIL'}** (${passCount}/${card.scores.length} fixtures pass)`);
  lines.push(`- Total Sonnet spend: $${card.totalCost.toFixed(4)}`);
  lines.push(`- Cache hit rate: ${(card.cacheHitRate * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('## Diff vs previous run');
  lines.push('');
  lines.push(diffSection(card, prev));
  lines.push('');
  lines.push('## Fixtures');
  lines.push('');
  lines.push(`| Fixture | Result | Outcome | $ |${hasVoice ? ' Voice |' : ''}`);
  lines.push(`| --- | --- | --- | --- |${hasVoice ? ' --- |' : ''}`);
  for (const s of card.scores) {
    const mark = s.pass ? '✅ pass' : s.knownFlaky ? '⚠️ flaky' : '❌ FAIL';
    const voice = hasVoice ? ` ${s.voice ? `${s.voice.score}/5` : '—'} |` : '';
    lines.push(`| ${s.name} | ${mark} | ${s.outcome} | ${s.costUsd.toFixed(3)} |${voice}`);
  }
  lines.push('');

  // Failure detail + transcripts.
  lines.push('## Detail');
  lines.push('');
  for (const r of results) {
    const score = card.scores.find((s) => s.name === r.fixture.name)!;
    lines.push(`### ${r.fixture.name}`);
    lines.push('');
    if (!score.pass) {
      lines.push(score.knownFlaky ? `_Known flaky: ${score.knownFlaky}_` : '**Failures:**');
      for (const f of r.failures) lines.push(`- ${f}`);
      lines.push('');
    }
    if (r.voice) {
      lines.push(`Voice ${r.voice.score}/5 — ${r.voice.note}`);
      lines.push('');
    }
    lines.push('<details><summary>transcript</summary>');
    lines.push('');
    lines.push('```');
    lines.push(transcriptBlock(r));
    lines.push('```');
    lines.push('</details>');
    lines.push('');
  }

  return lines.join('\n');
}

/** Render + write the timestamped scorecard, refresh the `previous.json` baseline,
 *  and return the file path. */
export function writeScorecard(results: DriveResult[]): { path: string; card: Scorecard } {
  const card = buildScorecard(results);
  const md = renderScorecard(card, results);
  const stamp = card.generatedAt.replace(/[:.]/g, '-').slice(0, 16);
  const outPath = path.join(process.cwd(), `onboarding-eval-${stamp}.md`);
  writeFileSync(outPath, md, 'utf8');
  // Refresh the diff baseline for the next run.
  writeFileSync(
    PREV_PATH(),
    JSON.stringify({ scores: card.scores.map((s) => ({ name: s.name, pass: s.pass })) }, null, 2),
    'utf8',
  );
  return { path: outPath, card };
}
