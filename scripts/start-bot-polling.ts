import { config } from 'dotenv';
config({ path: '.env.local' });

import { telegramBot } from '../src/server/telegram/bot';
import { checkSafeToPoll } from './polling-guard';

const mode = process.env.TELEGRAM_BOT_MODE ?? 'webhook';

if (mode === 'webhook') {
  console.error(
    '[bot:dev] TELEGRAM_BOT_MODE=webhook — polling is disabled in webhook mode. Set TELEGRAM_BOT_MODE=polling in .env.local to run the bot locally.',
  );
  process.exit(1);
}

const bot = telegramBot();

bot.on('message', async (ctx, next) => {
  const text = ctx.message.text ?? ctx.message.caption ?? '';
  console.info(`[tg] chat_id=${ctx.chat.id} text="${text.slice(0, 80)}"`);
  return next();
});

function shutdown() {
  console.info('[bot:dev] polling stopped');
  bot.stop();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

async function main(): Promise<void> {
  // Refuse to start if this token already has a webhook — polling would delete
  // it and take prod down. See scripts/polling-guard.ts for the full why.
  const info = await bot.api.getWebhookInfo();
  const guard = checkSafeToPoll(info.url);
  if (!guard.safe) {
    console.error(guard.message);
    process.exit(1);
  }

  await bot.start({ onStart: () => console.info('[bot:dev] polling started') });
}

main().catch((err) => {
  console.error('[bot:dev] fatal error', err);
  process.exit(1);
});
