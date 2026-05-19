import { Bot } from "grammy";

let _bot: Bot | null = null;

function getBot(): Bot {
  if (!_bot) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    _bot = new Bot(token);
    _bot.command("ping", (ctx) => ctx.reply("pong"));
  }
  return _bot;
}

export function telegramBot(): Bot {
  return getBot();
}

export async function pingTelegram(): Promise<{ latency_ms: number }> {
  const start = Date.now();
  await getBot().api.getMe();
  return { latency_ms: Date.now() - start };
}
