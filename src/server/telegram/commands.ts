// Single source of truth for the bot's command list. Both the BotFather menu
// (setMyCommands, via scripts/register-commands.ts) and the /help text read from
// here, so the two never drift.
//
// `inMenu: false` keeps dev/edge commands (ping, restart, disconnect_*, …) wired in
// bot.ts but out of the menu and /help — they work if you type them, they just
// aren't advertised. Descriptions are the menu labels: short, lowercase, no AI tells.

export type BotCommand = {
  command: string;
  description: string;
  inMenu: boolean;
};

export const BOT_COMMANDS: BotCommand[] = [
  { command: 'checkin', description: "log today's readiness and soreness", inMenu: true },
  { command: 'balance', description: 'check your credit balance', inMenu: true },
  { command: 'buy', description: 'add coaching credit', inMenu: true },
  { command: 'fresh_update', description: 'get a fresh update right now', inMenu: true },
  { command: 'pause', description: 'pause your daily check-ins', inMenu: true },
  { command: 'resume', description: 'turn your daily check-ins back on', inMenu: true },
  { command: 'adjust_plan', description: 'change your training plan', inMenu: true },
  { command: 'edit_profile', description: 'update your profile', inMenu: true },
  { command: 'calendar', description: 'sync your training to a calendar', inMenu: true },
  { command: 'prehab', description: 'your prehab routine', inMenu: true },
  { command: 'connect_strava', description: 'connect or reconnect Strava', inMenu: true },
  { command: 'help', description: 'what I can do, and how credits work', inMenu: true },

  // Wired in bot.ts but kept out of the menu/help — dev, recovery, or rarely needed.
  { command: 'ping', description: 'health check', inMenu: false },
  { command: 'start', description: 'link your account', inMenu: false },
  { command: 'restart', description: 'start onboarding over', inMenu: false },
  { command: 'cancel', description: 'cancel the current check-in', inMenu: false },
  { command: 'strava_status', description: 'show Strava connection details', inMenu: false },
  { command: 'disconnect_strava', description: 'disconnect Strava', inMenu: false },
  { command: 'disconnect_calendar', description: 'disconnect Google Calendar', inMenu: false },
];

/** The menu/help subset, in display order. */
export function menuCommands(): BotCommand[] {
  return BOT_COMMANDS.filter((c) => c.inMenu);
}

// The §9 disclosure: credits aren't 1:1 with tokens. Lives with the command list so
// /help renders one block. David's voice — short, no sell.
export const CREDITS_DISCLOSURE =
  'Credits are used to cover Daybreak costs, nothing more. The majority of your credits ' +
  'go to AI token costs, and a small slice goes to Stripe fees and hosting. The cost ' +
  'should come down over time as Daybreak becomes more token efficient.';

/** The full /help body: the menu commands as a list, then the credits note. */
export function helpText(): string {
  const lines = menuCommands().map((c) => `/${c.command} — ${c.description}`);
  return [
    "Here's what I can do:",
    '',
    ...lines,
    '',
    CREDITS_DISCLOSURE,
  ].join('\n');
}
