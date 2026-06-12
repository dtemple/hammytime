/**
 * Guard against local polling silently taking down the production bot.
 *
 * grammy's bot.start() calls deleteWebhook before it begins long-polling —
 * Telegram's webhook and getUpdates are mutually exclusive. If .env.local points
 * at the *production* bot token (which has a webhook registered), running
 * `npm run bot:dev` deletes that webhook and prod goes deaf to every message
 * until someone re-registers it. That happened once; this guard makes it
 * impossible by refusing to poll whenever the token already has a live webhook.
 *
 * Pure and side-effect free so it's unit-testable: the caller fetches
 * getWebhookInfo() and passes the url in.
 */
export type PollingGuardResult = { safe: boolean; message?: string };

export function checkSafeToPoll(webhookUrl: string | undefined | null): PollingGuardResult {
  if (webhookUrl && webhookUrl.length > 0) {
    return {
      safe: false,
      message:
        `[bot:dev] This bot already has a webhook registered at ${webhookUrl}.\n` +
        `Starting polling would DELETE it — grammy's bot.start() calls deleteWebhook,\n` +
        `and Telegram's webhook and getUpdates can't both be active.\n` +
        `You're almost certainly pointing .env.local at the PRODUCTION bot token.\n` +
        `Use a separate dev bot token in .env.local. If you really did mean to stop prod,\n` +
        `re-register afterward with: npm run webhook:register -- https://www.daybreak.run`,
    };
  }
  return { safe: true };
}
