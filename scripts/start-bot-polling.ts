import "dotenv/config";
import { telegramBot } from "../src/server/telegram/bot";

const mode = process.env.TELEGRAM_BOT_MODE ?? "webhook";

if (mode === "webhook") {
  console.error(
    "[bot:dev] TELEGRAM_BOT_MODE=webhook — polling is disabled in webhook mode. Set TELEGRAM_BOT_MODE=polling in .env.local to run the bot locally."
  );
  process.exit(1);
}

const bot = telegramBot();

bot.on("message", async (ctx, next) => {
  const text = ctx.message.text ?? ctx.message.caption ?? "";
  console.info(`[tg] chat_id=${ctx.chat.id} text="${text.slice(0, 80)}"`);
  return next();
});

const stop = bot.start({
  onStart: () => console.info("[bot:dev] polling started"),
});

function shutdown() {
  console.info("[bot:dev] polling stopped");
  bot.stop();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await stop;
