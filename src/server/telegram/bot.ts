import { execSync } from 'child_process';
import { Bot, CommandContext, Context } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import {
  handleOnboardingCallback,
  handleOnboardingMessage,
  onboardingSteps,
  resetOnboarding,
} from './onboarding/index';
import { handleCheckinCommand, handleWellnessMessage } from './checkin/dispatcher';
import { fetchRecentActivities, hasStravaConnection } from '@/server/strava/activities';
import { getOrCreateCalendarToken } from '@/lib/calendar-token';

let _bot: Bot | null = null;

function getBuildInfo(): string | null {
  try {
    return execSync('git log -1 --format="%h — %s"').toString().trim();
  } catch {
    return null;
  }
}

// Sends a message and persists it to the messages table (direction = 'out').
export async function sendAndLog(
  athleteId: string,
  chatId: number | string,
  text: string,
): Promise<void> {
  await getBot().api.sendMessage(chatId, text);
  await supabaseAdmin().from('messages').insert({
    athlete_id: athleteId,
    channel: 'tg',
    direction: 'out',
    body: text,
  });
}

async function handleStart(ctx: CommandContext<Context>): Promise<void> {
  const token = ctx.match?.trim();

  if (!token) {
    await ctx.reply('To get started, grab your invite link from the signup page.');
    return;
  }

  const db = supabaseAdmin();
  const { data, error } = await db.rpc('link_start_handshake', {
    p_token: token,
    p_telegram_chat_id: String(ctx.chat.id),
  });

  if (error) {
    console.error('[/start] link_start_handshake error', error);
    await ctx.reply('Something went wrong on our end — ping David.');
    return;
  }

  if (!data.ok) {
    const reason = data.reason as string;
    if (reason === 'not_found' || reason === 'expired' || reason === 'already_used') {
      await ctx.reply(
        'That link has expired or already been used. Head back to the signup page to get a fresh one.',
      );
    } else {
      await ctx.reply('Something went wrong — ping David.');
    }
    return;
  }

  const athleteId = data.athlete_id as string;

  // Log the inbound /start message now that we have an athlete_id
  await db.from('messages').insert({
    athlete_id: athleteId,
    channel: 'tg',
    direction: 'in',
    body: `/start ${token}`,
  });

  await sendAndLog(
    athleteId,
    ctx.chat.id,
    "Hi — I'm your training coach. We'll spend a few minutes getting you set up, then I'll give you a prompt to take to Claude or ChatGPT to build your training plan.",
  );

  // Ask the first onboarding question
  const firstQuestion = onboardingSteps[0]?.questions[0];
  if (firstQuestion) {
    await sendAndLog(athleteId, ctx.chat.id, firstQuestion.prompt);
  }
}

async function handleRestart(ctx: CommandContext<Context>): Promise<void> {
  const db = supabaseAdmin();
  const { data: athlete, error } = await db
    .from('athletes')
    .select('id')
    .eq('telegram_chat_id', String(ctx.chat.id))
    .maybeSingle();

  if (error || !athlete) {
    await ctx.reply('No account linked to this chat.');
    return;
  }

  await resetOnboarding(athlete.id);

  await ctx.reply('Starting over from the beginning.');

  const build = getBuildInfo();
  if (build) await ctx.reply(`[build: ${build}]`);

  const firstQuestion = onboardingSteps[0]?.questions[0];
  if (firstQuestion) {
    await sendAndLog(athlete.id, ctx.chat.id, firstQuestion.prompt);
  }
}

export async function handleInboundText(ctx: Context): Promise<void> {
  const db = supabaseAdmin();
  const { data: athlete, error } = await db
    .from('athletes')
    .select('*')
    .eq('telegram_chat_id', String(ctx.chat!.id))
    .maybeSingle();

  if (error || !athlete) {
    await ctx.reply('Use your invite link to get started.');
    return;
  }

  // Route to wellness battery if a check-in is in progress.
  // This check must come before the onboarding check — in practice the two
  // states won't coexist, but wellness wins if they ever do.
  const checkinState = athlete.checkin_state as Record<string, unknown> | null;
  if (checkinState?.sub_step) {
    await handleWellnessMessage(ctx, athlete);
    return;
  }

  const state = athlete.onboarding_state as { step?: number } | null;
  const step = typeof state?.step === 'number' ? state.step : 0;

  if (step < onboardingSteps.length) {
    await handleOnboardingMessage(ctx, athlete);
    return;
  }

  // Post-onboarding: route based on plan state
  const { data: plan } = await db
    .from('plans')
    .select('id')
    .eq('athlete_id', athlete.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!plan) {
    // Help path (no plan row created) or unexpected state
    await ctx.reply("Sit tight — David's on it. He'll be in touch.");
    return;
  }

  const { data: version } = await db
    .from('plan_versions')
    .select('status')
    .eq('plan_id', plan.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!version) {
    console.warn('[bot] athlete has a plan row but no plan_versions row', athlete.id);
    await ctx.reply('Your onboarding is complete — daily coaching is coming soon.');
    return;
  }

  if (version.status === 'awaiting_paste') {
    await ctx.reply('Your plan is being set up. Daily coaching is coming soon.');
  } else if (version.status === 'active') {
    await ctx.reply('All set. Daily check-ins start when that side of the bot ships.');
  } else {
    await ctx.reply('Your onboarding is complete — daily coaching is coming soon.');
  }
}

export async function handleConnectStravaCommand(ctx: CommandContext<Context>): Promise<void> {
  const db = supabaseAdmin();
  const chatId = String(ctx.chat.id);

  const { data: athlete } = await db
    .from('athletes')
    .select('*')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();

  if (!athlete) {
    await ctx.reply('Use your invite link to get started.');
    return;
  }

  const obState = athlete.onboarding_state as { step?: number } | null;
  if ((typeof obState?.step === 'number' ? obState.step : 0) < onboardingSteps.length) {
    await ctx.reply('Finish onboarding first.');
    return;
  }

  // Log inbound command now that we have an athlete_id.
  await db.from('messages').insert({
    athlete_id: athlete.id,
    channel: 'tg',
    direction: 'in',
    body: '/connect_strava',
  });

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  const connectUrl = `${baseUrl}/strava/connect?athlete_id=${athlete.id}`;

  await sendAndLog(
    athlete.id,
    ctx.chat.id,
    `Tap here to connect Strava: ${connectUrl}\n\nI'll confirm when you're back.`,
  );
}

async function handleCalendarCommand(ctx: CommandContext<Context>): Promise<void> {
  const db = supabaseAdmin();
  const chatId = String(ctx.chat.id);

  const { data: athlete } = await db
    .from('athletes')
    .select('id, onboarding_state')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();

  if (!athlete) {
    await ctx.reply('Use your invite link to get started.');
    return;
  }

  const obState = athlete.onboarding_state as { step?: number } | null;
  if ((typeof obState?.step === 'number' ? obState.step : 0) < onboardingSteps.length) {
    await ctx.reply('Finish onboarding first.');
    return;
  }

  await db.from('messages').insert({
    athlete_id: athlete.id,
    channel: 'tg',
    direction: 'in',
    body: '/calendar',
  });

  const { url } = await getOrCreateCalendarToken(athlete.id);

  const reply = [
    'Your training calendar:',
    url,
    '',
    'Subscribe in:',
    '• Apple Calendar — File → New Calendar Subscription → paste URL',
    '• Google Calendar — Other calendars → + → From URL → paste URL',
    '• Outlook — Add calendar → Subscribe from web → paste URL',
    '',
    'Workouts will appear on their day. Updates automatically when your plan changes.',
  ].join('\n');

  await sendAndLog(athlete.id, ctx.chat.id, reply);
}

async function handleStravaStatusCommand(ctx: CommandContext<Context>): Promise<void> {
  const db = supabaseAdmin();
  const chatId = String(ctx.chat.id);

  const { data: athlete } = await db
    .from('athletes')
    .select('id')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();

  if (!athlete) {
    await ctx.reply('No athlete record found for this chat.');
    return;
  }

  const connected = await hasStravaConnection(athlete.id);
  if (!connected) {
    await ctx.reply('No Strava connection on file. Run /connect_strava.');
    return;
  }

  const { data: tokenRow } = await db
    .from('oauth_tokens')
    .select('provider_athlete_id, expires_at')
    .eq('athlete_id', athlete.id)
    .eq('provider', 'strava')
    .maybeSingle();

  let activityCount = 0;
  let fetchError: string | null = null;
  try {
    const activities = await fetchRecentActivities(athlete.id, 14);
    activityCount = activities.length;
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  const lines = [
    `Strava athlete ID on file: ${tokenRow?.provider_athlete_id ?? 'unknown'}`,
    `Token expires: ${tokenRow?.expires_at ?? 'unknown'}`,
    fetchError
      ? `Activities fetch error: ${fetchError}`
      : `Activities in past 14 days: ${activityCount}`,
  ];
  await ctx.reply(lines.join('\n'));
}

function getBot(): Bot {
  if (!_bot) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    _bot = new Bot(token);
    _bot.command('ping', (ctx) => ctx.reply('pong'));
    _bot.command('start', handleStart);
    _bot.command('restart', handleRestart);
    _bot.command('checkin', async (ctx) => {
      const db = supabaseAdmin();
      const { data: athlete } = await db
        .from('athletes')
        .select('*')
        .eq('telegram_chat_id', String(ctx.chat.id))
        .maybeSingle();
      if (!athlete) {
        await ctx.reply('Use your invite link to get started.');
        return;
      }
      const obState = athlete.onboarding_state as { step?: number } | null;
      if ((typeof obState?.step === 'number' ? obState.step : 0) < onboardingSteps.length) {
        await ctx.reply('Finish onboarding first.');
        return;
      }
      await handleCheckinCommand(ctx, athlete);
    });
    _bot.command('connect_strava', handleConnectStravaCommand);
    _bot.command('strava_status', handleStravaStatusCommand);
    _bot.command('calendar', handleCalendarCommand);
    _bot.command('cancel', async (ctx) => {
      const db = supabaseAdmin();
      const { data: athlete } = await db
        .from('athletes')
        .select('id, checkin_state')
        .eq('telegram_chat_id', String(ctx.chat.id))
        .maybeSingle();
      if (!athlete) {
        await ctx.reply('Nothing to cancel.');
        return;
      }
      const cs = athlete.checkin_state as Record<string, unknown> | null;
      if (!cs?.sub_step) {
        await ctx.reply('No active check-in to cancel.');
        return;
      }
      await db.from('athletes').update({ checkin_state: {} }).eq('id', athlete.id);
      await ctx.reply('Cancelled.');
    });
    _bot.on('message:text', async (ctx) => {
      if (!ctx.message.text.startsWith('/')) {
        await handleInboundText(ctx);
      }
    });
    _bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const db = supabaseAdmin();
      const { data: athlete } = await db
        .from('athletes')
        .select('*')
        .eq('telegram_chat_id', String(ctx.from.id))
        .maybeSingle();

      if (!athlete) {
        await ctx.answerCallbackQuery();
        return;
      }

      const state = athlete.onboarding_state as { step?: number } | null;
      const stepIdx = typeof state?.step === 'number' ? state.step : 0;

      if (stepIdx >= onboardingSteps.length) {
        await ctx.answerCallbackQuery();
        return;
      }

      const step = onboardingSteps[stepIdx];
      if (!step?.handleCallback) {
        await ctx.answerCallbackQuery();
        return;
      }

      await handleOnboardingCallback(ctx, athlete, data);
    });
    _bot.catch((err) => {
      const ctx = err.ctx;
      console.error('[bot] unhandled error', `chat=${ctx?.chat?.id ?? 'no-chat'}`, err.error);
      // Best-effort reply — .catch(() => undefined) so a failed reply doesn't re-throw.
      ctx?.reply('Something went wrong on our end — ping David.').catch(() => undefined);
    });
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

/**
 * Resets the bot singleton. Test-only — allows tests to reinitialize the Bot
 * mock between cases without module re-imports.
 * @internal
 */
export function _resetBotForTest(): void {
  _bot = null;
}
