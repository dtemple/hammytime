import { telegramBot } from "@/server/telegram/bot";

export async function sendDavidAlert(message: string): Promise<void> {
  const chatId = process.env.DAVID_TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.warn("[alerts] DAVID_TELEGRAM_CHAT_ID not set — skipping David alert");
    return;
  }
  await telegramBot().api.sendMessage(chatId, message);
}
