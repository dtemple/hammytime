// Outbound Telegram for the worker. Separate from the inbound bot (src/server/
// telegram/bot.ts) so the worker process doesn't register command handlers —
// it only sends. Chunks at Telegram's 4096-char limit.

import { Bot } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import { resolveExercise } from '@/lib/exercise-library';

const TELEGRAM_MAX_CHARS = 4096;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The coach marks an exercise link as `[visible text](slug)` where slug is a
// corpus id (worker/knowledge/exercises.md). Slug is constrained to id-shaped
// chars so arbitrary parens in prose can't be mistaken for a link.
const LINK_TOKEN_RE = /\[([^\]]+)\]\(([a-z0-9-]+)\)/g;

/**
 * Renders a coach message for Telegram HTML parse mode. The whole string is
 * HTML-escaped first, then the controlled `[text](slug)` tokens become `<a>`
 * tags resolved against the corpus — a matched slug links to its canonical
 * `source`, an unmatched one collapses to plain text (no link, no fabricated
 * URL). Escaping happens before substitution, so arbitrary agent prose can
 * never break parsing, and the only URLs that appear are corpus `source`s.
 */
export function renderTelegramHtml(text: string): string {
  return escapeHtml(text).replace(LINK_TOKEN_RE, (_m, label: string, slug: string) => {
    const entry = resolveExercise({ slug });
    if (!entry) return label;
    const href = escapeHtml(entry.source).replace(/"/g, '&quot;');
    return `<a href="${href}">${label}</a>`;
  });
}

let _bot: Bot | null = null;

function bot(): Bot {
  if (!_bot) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    _bot = new Bot(token);
  }
  return _bot;
}

const TYPING_REFRESH_MS = 4000; // Telegram clears 'typing' after ~5s; refresh under that.

/**
 * Starts a repeating 'typing…' chat action for the athlete and returns a stop fn.
 * Best-effort: a missing chat_id or a failed action never throws into the caller.
 */
export async function startTyping(athleteId: string): Promise<() => void> {
  const { data: athlete } = await supabaseAdmin()
    .from('athletes')
    .select('telegram_chat_id')
    .eq('id', athleteId)
    .maybeSingle();

  const chatId = athlete?.telegram_chat_id;
  if (!chatId) return () => {};

  const ping = () =>
    bot()
      .api.sendChatAction(chatId, 'typing')
      .catch((e) => console.warn('[worker] sendChatAction failed', e));

  void ping(); // fire immediately
  const timer = setInterval(() => void ping(), TYPING_REFRESH_MS);
  return () => clearInterval(timer);
}

export function chunk(text: string, size = TELEGRAM_MAX_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < trimmed.length; i += size) {
    out.push(trimmed.slice(i, i + size));
  }
  return out;
}

/**
 * Sends `text` to the athlete and persists each chunk to `messages`.
 */
export async function sendReply(athleteId: string, text: string, runId?: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: athlete } = await db
    .from('athletes')
    .select('telegram_chat_id')
    .eq('id', athleteId)
    .maybeSingle();

  if (!athlete?.telegram_chat_id) {
    throw new Error(`sendReply: athlete ${athleteId} has no telegram_chat_id`);
  }

  const chunks = chunk(text);
  if (chunks.length === 0) return;

  for (const part of chunks) {
    // Render per chunk: substitution happens after the 4096 split, so an <a>
    // tag can never straddle a boundary and break the send. We store the
    // original `[text](slug)` token text — readable, no URL spam in the log.
    await bot().api.sendMessage(athlete.telegram_chat_id, renderTelegramHtml(part), {
      parse_mode: 'HTML',
    });
    await db.from('messages').insert({
      athlete_id: athleteId,
      channel: 'tg',
      direction: 'out',
      body: part,
      related_run_id: runId ?? null,
    });
  }
}
