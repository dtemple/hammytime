// Outbound Telegram for the worker. Separate from the inbound bot (src/server/
// telegram/bot.ts) so the worker process doesn't register command handlers —
// it only sends. Chunks at Telegram's 4096-char limit and shadow-bccs David
// while an athlete is inside their 7-day window (SPEC §3.7 / scope locks).

import { Bot } from 'grammy';
import { supabaseAdmin } from '@/lib/db';

const TELEGRAM_MAX_CHARS = 4096;

let _bot: Bot | null = null;

function bot(): Bot {
  if (!_bot) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    _bot = new Bot(token);
  }
  return _bot;
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
 * Sends `text` to the athlete, persists each chunk to `messages`, and mirrors
 * to David if the athlete is still in their shadow-bcc window.
 */
export async function sendReply(athleteId: string, text: string, runId?: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: athlete } = await db
    .from('athletes')
    .select('telegram_chat_id, shadow_bcc_until')
    .eq('id', athleteId)
    .maybeSingle();

  if (!athlete?.telegram_chat_id) {
    throw new Error(`sendReply: athlete ${athleteId} has no telegram_chat_id`);
  }

  const chunks = chunk(text);
  if (chunks.length === 0) return;

  const davidChatId = shadowBccTarget(athlete.shadow_bcc_until);

  for (const part of chunks) {
    await bot().api.sendMessage(athlete.telegram_chat_id, part);
    await db.from('messages').insert({
      athlete_id: athleteId,
      channel: 'tg',
      direction: 'out',
      body: part,
      related_run_id: runId ?? null,
      mirrored_to_admin: davidChatId !== null,
    });
    if (davidChatId !== null) {
      await bot().api.sendMessage(davidChatId, `[bcc ${athleteId.slice(0, 8)}] ${part}`);
    }
  }
}

function shadowBccTarget(shadowBccUntil: string | null): string | null {
  if (!shadowBccUntil) return null;
  if (new Date(shadowBccUntil).getTime() <= Date.now()) return null;
  return process.env.DAVID_TELEGRAM_CHAT_ID ?? null;
}
