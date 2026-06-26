// V4-W6 — the simulated athlete. A Sonnet call in character that answers whatever
// the bot just asked, from a fixture's persona + ground-truth fact sheet.
//
// Why a simulator and not a fixed reply script: the bot's questions vary run to
// run (Sonnet is non-deterministic), so a fixed script desyncs on the terse /
// adversarial personas. The simulator stays in sync because it reads the bot's
// actual last message each turn. Forced moves (drive.ts) are the escape hatch for
// the token-exact turns a script still needs.

import { anthropicClient } from '@/lib/anthropic';
import { ONBOARDING_MODEL } from '../extract-and-advance';
import type { TranscriptTurn } from './types';

const MAX_TOKENS = 400;

export interface SimulatedReply {
  reply: { kind: 'text'; body: string } | { kind: 'chip'; label: string };
  inputTokens: number;
  outputTokens: number;
}

const REPLY_TOOL = {
  name: 'athlete_reply',
  description:
    'Reply to the coach as the athlete you are playing. Either type a short message, or tap one of the offered buttons by its exact label.',
  input_schema: {
    type: 'object' as const,
    required: ['kind'],
    properties: {
      kind: {
        type: 'string',
        enum: ['text', 'chip'],
        description: "'text' to type a reply; 'chip' to tap one of the offered buttons.",
      },
      text: {
        type: 'string',
        description: "When kind='text', your reply in the athlete's voice. One short message.",
      },
      chip_label: {
        type: 'string',
        description: "When kind='chip', the EXACT label of the button you are tapping.",
      },
    },
  },
} as const;

function buildSystem(persona: string, facts: Record<string, unknown>): string {
  return [
    'You are role-playing a runner who is signing up for a coaching app over text. Stay in character.',
    `Your persona: ${persona}`,
    'Your ground-truth facts (answer FROM these; never invent facts beyond them — if asked something the facts do not cover, give a natural in-character non-answer or a best guess a person like you would give):',
    JSON.stringify(facts, null, 2),
    'Rules:',
    '- Reply the way THIS person would: match the persona for length, tone, and disfluency. A terse persona gives one or two words. A chatty one over-shares.',
    '- Never break character, never mention that you are an AI or a simulation, never describe the facts as "facts" or "ground truth".',
    "- Answer only what the coach actually asked. Do not volunteer the whole profile unless the persona is a chatty over-answerer.",
    '- If buttons are offered and one matches what you want to say, tap it (kind="chip", exact label). Otherwise type a reply (kind="text").',
    '- Always call athlete_reply. Never reply in plain prose.',
    // Anti-desync hardening for the terse / adversarial personas: stay in
    // character, but never stonewall forever. If the coach has already asked the
    // same thing once, give a real answer from your facts this time so the
    // conversation can move — a real person eventually answers.',
    '- You can be terse or skeptical if that is your persona, but if the coach asks the same question a second time, give a straight answer from your facts. Do not loop.',
  ].join('\n\n');
}

function formatConversation(turns: TranscriptTurn[]): string {
  return turns
    .map((t) => `${t.direction === 'athlete' ? 'You' : 'Coach'}: ${t.body}`)
    .join('\n');
}

/**
 * Produce the athlete's next move given the conversation so far and the coach's
 * latest message + offered chips. A Sonnet call in character.
 */
export async function simulateAthlete(
  persona: string,
  facts: Record<string, unknown>,
  conversationSoFar: TranscriptTurn[],
  botMessage: string,
  chips: Array<{ label: string; data: string }>,
): Promise<SimulatedReply> {
  const client = anthropicClient();

  const userContent = [
    conversationSoFar.length
      ? `Conversation so far:\n${formatConversation(conversationSoFar)}`
      : 'This is the start of the conversation.',
    '',
    `The coach just said:\n${botMessage}`,
    chips.length ? `\nButtons offered: ${chips.map((c) => `"${c.label}"`).join(', ')}` : '',
    '',
    'Your move:',
  ]
    .filter(Boolean)
    .join('\n');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (client.messages as any).create({
    model: ONBOARDING_MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystem(persona, facts),
    tools: [REPLY_TOOL],
    tool_choice: { type: 'tool', name: 'athlete_reply' },
    messages: [{ role: 'user', content: userContent }],
  });

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  const toolUse = (response.content as unknown[]).find(
    (b: unknown) => (b as { type?: string }).type === 'tool_use',
  ) as { input?: { kind?: string; text?: string; chip_label?: string } } | undefined;

  const input = toolUse?.input ?? {};

  // A chip tap only counts if it matches an offered label; otherwise treat the
  // model's text (or a bare fallback) as a typed reply so the loop never stalls.
  if (input.kind === 'chip' && input.chip_label && chips.some((c) => c.label === input.chip_label)) {
    return { reply: { kind: 'chip', label: input.chip_label }, inputTokens, outputTokens };
  }

  const body = (input.text ?? '').trim() || "Not sure, what do you need?";
  return { reply: { kind: 'text', body }, inputTokens, outputTokens };
}
