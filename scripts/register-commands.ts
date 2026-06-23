// Usage: npm run commands:register
//
// Pushes the BotFather command menu from the single source of truth (commands.ts).
// Run once after a deploy that changes the menu. Idempotent — setMyCommands replaces
// the whole list each time. Targets the bot named by TELEGRAM_BOT_TOKEN in .env.local.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Bot } from 'grammy';
import { menuCommands } from '../src/server/telegram/commands';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

const commands = menuCommands().map((c) => ({
  command: c.command,
  description: c.description,
}));

const bot = new Bot(token);

(async () => {
  console.log(`Registering ${commands.length} commands:`);
  for (const c of commands) console.log(`  /${c.command} — ${c.description}`);
  const result = await bot.api.setMyCommands(commands);
  console.log('setMyCommands result:', result);
})();
