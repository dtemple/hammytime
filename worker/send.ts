// Outbound Telegram for the worker. Separate from the inbound bot (src/server/
// telegram/bot.ts) so the worker process doesn't register command handlers —
// it only sends. Chunks at Telegram's 4096-char limit.
//
// Shadow-bcc (mirroring every outbound message to David while an athlete is
// inside their 7-day window, SPEC §3.7) is currently DISABLED — it added noise
// and per-deploy context to track, and all outbound messages are already in the
// `messages` table. To restore, see the commented `shadowBccTarget` below and
// re-wire `davidChatId` in `sendReply`.

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
 * Sends `text` to the athlete and persists each chunk to `messages`.
 *
 * Shadow-bcc mirroring to David is disabled (see file header). `davidChatId`
 * is pinned to `null`; restore it via `shadowBccTarget` below to re-enable.
 */
export async function sendReply(athleteId: string, text: string, runId?: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: athlete } = await db
    .from('athletes')
    // `shadow_bcc_until` left unselected — shadow-bcc disabled.
    .select('telegram_chat_id')
    .eq('id', athleteId)
    .maybeSingle();

  if (!athlete?.telegram_chat_id) {
    throw new Error(`sendReply: athlete ${athleteId} has no telegram_chat_id`);
  }

  const chunks = chunk(text);
  if (chunks.length === 0) return;

  // Shadow-bcc disabled: never mirror to David.
  const davidChatId: string | null = null;

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
    // Shadow-bcc disabled — no copy is sent to David. To restore, re-derive
    // davidChatId from shadowBccTarget(athlete.shadow_bcc_until) above and
    // re-enable this block:
    // if (davidChatId !== null) {
    //   await bot().api.sendMessage(davidChatId, `[bcc ${athleteId.slice(0, 8)}] ${part}`);
    // }
  }
}

// Shadow-bcc disabled (see file header). Kept for easy restore — when an
// athlete is inside their 7-day window this returns David's chat id.
// function shadowBccTarget(shadowBccUntil: string | null): string | null {
//   if (!shadowBccUntil) return null;
//   if (new Date(shadowBccUntil).getTime() <= Date.now()) return null;
//   return process.env.DAVID_TELEGRAM_CHAT_ID ?? null;
// }
