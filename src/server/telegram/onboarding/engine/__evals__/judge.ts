// V4-W6 Part 5 — the optional voice judge. Off by default; enabled by `--judge` /
// EVAL_JUDGE. Opus scores the captured coach transcript 1–5 against the CLAUDE.md
// §3 bar (no sycophancy, no "not X, that's Y", no rule-of-three filler, must not
// read as AI-generated). Additive only — it never touches the deterministic
// pass/fail; the scorecard gains a voice column.

import { anthropicClient } from '@/lib/anthropic';
import type { DriveResult } from './types';

const JUDGE_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 400;
// Opus pricing, USD per million tokens.
const COST_PER_M_INPUT = 15.0;
const COST_PER_M_OUTPUT = 75.0;

export function judgeEnabled(): boolean {
  return !!process.env.EVAL_JUDGE || process.argv.includes('--judge');
}

const RUBRIC = [
  'You are auditing the VOICE of a running coach that texts athletes during onboarding.',
  'Score 1–5 how human and on-voice the coach messages read, per these rules:',
  '- Must NOT read as AI-generated. This is the load-bearing test.',
  '- No sycophancy: no "Great question", no "I\'d be happy to", no praising the athlete for answering.',
  '- No "That\'s not X. That\'s Y." construction.',
  '- No rule-of-three filler, no inflated/promotional phrasing, no negative parallelisms.',
  '- Avoids the words "genuinely", "honestly", "straightforward", "niggle".',
  'Plain, warm, direct, one idea per message reads as a 5. Stiff, peppy, or templated reads low.',
  'Score ONLY the Coach lines. Ignore the athlete lines and ignore whether the conversation succeeded.',
].join('\n');

const SCORE_TOOL = {
  name: 'voice_score',
  description: 'Record the voice score for the coach transcript.',
  input_schema: {
    type: 'object' as const,
    required: ['score', 'justification'],
    properties: {
      score: { type: 'integer', description: '1 (reads as AI / sycophantic) to 5 (reads fully human).' },
      justification: { type: 'string', description: 'One line: the single biggest reason for the score.' },
    },
  },
} as const;

export interface VoiceJudgement {
  score: number;
  note: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export async function judgeVoice(result: DriveResult): Promise<VoiceJudgement> {
  const coachLines = result.transcript
    .filter((t) => t.direction === 'coach')
    .map((t) => `Coach: ${t.body}`)
    .join('\n');

  const client = anthropicClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (client.messages as any).create({
    model: JUDGE_MODEL,
    max_tokens: MAX_TOKENS,
    system: RUBRIC,
    tools: [SCORE_TOOL],
    tool_choice: { type: 'tool', name: 'voice_score' },
    messages: [{ role: 'user', content: `Coach transcript:\n\n${coachLines || '(no coach messages)'}` }],
  });

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const costUsd =
    (inputTokens / 1_000_000) * COST_PER_M_INPUT + (outputTokens / 1_000_000) * COST_PER_M_OUTPUT;

  const toolUse = (response.content as unknown[]).find(
    (b: unknown) => (b as { type?: string }).type === 'tool_use',
  ) as { input?: { score?: number; justification?: string } } | undefined;

  const score = Number(toolUse?.input?.score ?? 0);
  const note = String(toolUse?.input?.justification ?? '(no justification)');
  return { score, note, inputTokens, outputTokens, costUsd };
}
