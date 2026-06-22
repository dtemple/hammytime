// Outbound Telegram for the worker. Separate from the inbound bot (src/server/
// telegram/bot.ts) so the worker process doesn't register command handlers —
// it only sends. Chunks at Telegram's 4096-char limit.

import { Bot, InlineKeyboard } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import { getOrCreatePrehabToken } from '@/lib/calendar-token';
import { resolveExercise } from '@/lib/exercise-library';

const TELEGRAM_MAX_CHARS = 4096;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The coach marks an exercise link as `[visible text](slug)` where slug is a
// corpus id (worker/knowledge/exercises.md). Slug is constrained to id-shaped
// chars so arbitrary parens in prose can't be mistaken for a link.
const LINK_TOKEN_RE = /\[([^\]]+)\]\(([a-z0-9-]+)\)/g;

// Reserved slug for the athlete's prehab routine page — resolved by sendReply
// to their tokened URL, never by the corpus. Must never collide with an
// exercises.md id.
export const PREHAB_LINK_SLUG = 'prehab-routine';

// Markdown bold the agent emits by habit. Telegram HTML mode doesn't render
// markdown, so `**x**` would show as literal asterisks — convert it to <b>.
// Only the double-asterisk form is converted: single `*`/`_` are unsafe (they
// collide with snake_case filenames like `race_calendar.md` and with prose),
// so those are left alone. `.+?` has no /s flag, so a `**` never spans a line.
const BOLD_RE = /\*\*(.+?)\*\*/g;

/**
 * Renders a coach message for Telegram HTML parse mode. The whole string is
 * HTML-escaped first, then `**bold**` becomes `<b>` and the controlled
 * `[text](slug)` tokens become `<a>` tags — a slug resolves through
 * `extraLinks` (reserved, system-built URLs like the prehab routine page)
 * first, then the corpus; an unmatched one collapses to plain text (no link,
 * no fabricated URL). extraLinks wins so a future corpus entry can never
 * shadow a reserved slug. Escaping happens before any substitution, so
 * arbitrary agent prose can never break parsing, and the only URLs that
 * appear are corpus `source`s and the system-built extras. Bold runs before
 * links so a bolded link (`**[name](slug)**`) nests as `<b><a>…</a></b>`.
 */
export function renderTelegramHtml(text: string, extraLinks?: Record<string, string>): string {
  return escapeHtml(text)
    .replace(BOLD_RE, '<b>$1</b>')
    .replace(LINK_TOKEN_RE, (_m, label: string, slug: string) => {
      const href = extraLinks?.[slug] ?? resolveExercise({ slug })?.source;
      if (!href) return label;
      const escaped = escapeHtml(href).replace(/"/g, '&quot;');
      return `<a href="${escaped}">${label}</a>`;
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

/**
 * Sends an internal alert to David via the worker's own outbound bot. Mirrors
 * src/server/admin/alerts.ts but deliberately does NOT import the inbound bot
 * (which registers command handlers) — see the file header. Plain text, no parse
 * mode. Safe no-op when DAVID_TELEGRAM_CHAT_ID is unset.
 */
export async function sendDavidAlert(message: string): Promise<void> {
  const chatId = process.env.DAVID_TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.warn('[worker] DAVID_TELEGRAM_CHAT_ID not set — skipping David alert');
    return;
  }
  await bot().api.sendMessage(chatId, message);
}

// Message 2 of a plan proposal (Specs/CALENDAR_CONFIRM.md): terse and
// system-like on purpose — the coach's prose (message 1) already explained the
// change. Copy is a draft pending David's voice pass.
const CALENDAR_CONFIRM_TEXT = 'Update your calendar?';

/**
 * Sends the confirm keyboard for a staged plan proposal: one row, Yes/No,
 * callback data `cal:y:<token>` / `cal:n:<token>` (handled bot-side by
 * handleCalendarConfirm). Logs the message and stores its message_id on the
 * plans row — keyed on the token, so a raced supersede can't attach the id to
 * the wrong proposal.
 */
export async function sendCalendarConfirm(athleteId: string, token: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: athlete } = await db
    .from('athletes')
    .select('telegram_chat_id')
    .eq('id', athleteId)
    .maybeSingle();

  if (!athlete?.telegram_chat_id) {
    throw new Error(`sendCalendarConfirm: athlete ${athleteId} has no telegram_chat_id`);
  }

  const keyboard = new InlineKeyboard()
    .text('Yes, update', `cal:y:${token}`)
    .text('No, leave it', `cal:n:${token}`);

  const sent = await bot().api.sendMessage(athlete.telegram_chat_id, CALENDAR_CONFIRM_TEXT, {
    reply_markup: keyboard,
  });

  await db.from('messages').insert({
    athlete_id: athleteId,
    channel: 'tg',
    direction: 'out',
    body: CALENDAR_CONFIRM_TEXT,
  });

  await db
    .from('plans')
    .update({ proposed_message_id: sent.message_id })
    .eq('proposed_token', token);
}

/**
 * Resolves a superseded proposal's keyboard message so it can't be tapped —
 * cosmetic honesty; a tap on it would be a harmless not_found anyway.
 * Best-effort: failures log, never throw into the caller. Copy is a draft.
 */
export async function resolveStaleProposalMessage(
  athleteId: string,
  messageId: number,
  note = 'Replaced by a newer proposal — see below.',
): Promise<void> {
  try {
    const { data: athlete } = await supabaseAdmin()
      .from('athletes')
      .select('telegram_chat_id')
      .eq('id', athleteId)
      .maybeSingle();
    if (!athlete?.telegram_chat_id) return;

    await bot().api.editMessageText(
      athlete.telegram_chat_id,
      messageId,
      `${CALENDAR_CONFIRM_TEXT}\n\n${note}`,
    );
  } catch (e) {
    console.warn(`[worker] resolveStaleProposalMessage failed for ${athleteId}:`, e);
  }
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

  // The prehab routine link is resolved lazily — only when the coach actually
  // emitted the reserved token — so ordinary messages cost no extra query. A
  // mint failure logs and the token collapses to its plain label downstream.
  let extraLinks: Record<string, string> | undefined;
  if (text.includes(`](${PREHAB_LINK_SLUG})`)) {
    try {
      const { url } = await getOrCreatePrehabToken(athleteId);
      extraLinks = { [PREHAB_LINK_SLUG]: url };
    } catch (e) {
      console.warn('[worker] prehab routine token resolution failed', e);
    }
  }

  for (const part of chunks) {
    // Render per chunk: substitution happens after the 4096 split, so an <a>
    // tag can never straddle a boundary and break the send. We store the
    // original `[text](slug)` token text — readable, no URL spam in the log.
    await bot().api.sendMessage(athlete.telegram_chat_id, renderTelegramHtml(part, extraLinks), {
      parse_mode: 'HTML',
      // Exercise links are inline references, not shared articles — suppress
      // Telegram's auto-generated preview card for the last URL in the message.
      link_preview_options: { is_disabled: true },
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
