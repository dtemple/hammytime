// Usage: npm run webhook:register -- https://abc123.ngrok.io
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Bot } from 'grammy';

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET not set');

const rawUrl = process.argv[2];
if (!rawUrl) {
  console.error('Usage: npm run webhook:register -- <public-url>');
  console.error('Example: npm run webhook:register -- https://abc123.ngrok.io');
  process.exit(1);
}

const webhookUrl = `${rawUrl.replace(/\/$/, '')}/api/tg/webhook`;
const bot = new Bot(token);

(async () => {
  console.log('Registering webhook at:', webhookUrl);
  const result = await bot.api.setWebhook(webhookUrl, { secret_token: secret });
  console.log('setWebhook result:', result);

  const info = await bot.api.getWebhookInfo();
  console.log('Webhook info:', JSON.stringify(info, null, 2));
})();
