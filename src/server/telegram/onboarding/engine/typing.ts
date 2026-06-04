// Onboarding v3 (V3-W2): a webhook-side "typing…" indicator.
//
// The worker has worker/send.ts `startTyping`, but it's bound to the worker's own
// bot singleton. The onboarding turn runs in the Next.js webhook path, so it needs
// its own — over `botApiForChat` so the staging-bot routing (group chats) holds.
// Masks Sonnet's per-turn latency; without it the pause reads as a stuck bot.

import { botApiForChat } from '../../bot';

const TYPING_REFRESH_MS = 4000; // Telegram clears 'typing' after ~5s.

/** Run `fn` while a repeating 'typing…' action shows in the chat. Best-effort —
 *  a failed chat action never affects `fn`'s result; the timer always stops. */
export async function withTyping<T>(chatId: number | string, fn: () => Promise<T>): Promise<T> {
  const api = botApiForChat(chatId);
  const ping = () => api.sendChatAction(chatId, 'typing').catch(() => {});
  void ping();
  const timer = setInterval(() => void ping(), TYPING_REFRESH_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
