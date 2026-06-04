import { execSync } from 'child_process';
import { Bot, CommandContext, Context, InlineKeyboard } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import type { Database } from '@/lib/db-types';
import {
  advanceQuestion,
  handleOnboardingCallback,
  handleOnboardingMessage,
  labelForTap,
  onboardingSteps,
  hardResetOnboarding,
} from './onboarding/index';
import { handleCheckinCommand, handleWellnessMessage } from './checkin/dispatcher';
import { handleV3Message, handleV3Callback } from './onboarding/engine/router';
import { fetchRecentActivities, hasStravaConnection } from '@/server/strava/activities';
import { disconnectStrava } from '@/server/strava/disconnect';
import { getOrCreateCalendarToken } from '@/lib/calendar-token';
import { enqueueJob } from '@/server/jobs/enqueue';
import { transcribeOgg } from '@/lib/transcribe';

type AthleteRow = Database['public']['Tables']['athletes']['Row'];

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

// Web base URL for OAuth handoff links.
export function appBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  );
}

export function stravaConnectUrl(athleteId: string): string {
  return `${appBaseUrl()}/strava/connect?athlete_id=${athleteId}`;
}

// Beat A0 (onboarding v2): welcome + the Connect Strava unlock. Seeds the
// onboarding state to 'awaiting_strava' so the Strava callback's resumeAfterStrava
// can advance the athlete into profile-confirm (step 0). Shared by /start and /restart.
async function sendWelcomeAndConnect(athleteId: string, chatId: number | string): Promise<void> {
  await advanceQuestion(athleteId, {
    step: 0,
    question: 0,
    partial: { sub_step: 'awaiting_strava' },
  });

  const keyboard = new InlineKeyboard().url('Connect Strava', stravaConnectUrl(athleteId));
  await getBot().api.sendMessage(
    chatId,
    'Welcome! Daybreak needs a Strava connection to work. ' +
      'Connect your Strava account here to begin.',
    { reply_markup: keyboard },
  );
  await supabaseAdmin().from('messages').insert({
    athlete_id: athleteId,
    channel: 'tg',
    direction: 'out',
    body: 'Welcome. Connect Strava to get started.',
  });
}

async function handleStart(ctx: CommandContext<Context>): Promise<void> {
  const token = ctx.match?.trim();

  if (!token) {
    await ctx.reply('To get started, get an invite link from the daybreak.run signup page.');
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

  await sendWelcomeAndConnect(athleteId, ctx.chat.id);
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

  await hardResetOnboarding(athlete.id);

  await ctx.reply('Starting over from the beginning.');

  const build = getBuildInfo();
  if (build) await ctx.reply(`[build: ${build}]`);

  await sendWelcomeAndConnect(athlete.id, ctx.chat.id);
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

  const ob = athlete.onboarding_state as { flow?: string; phase?: string; step?: number } | null;

  // Onboarding v3: the engine drives every turn until the plan is generated
  // (phase 'complete'), after which we fall through to the coaching path below.
  if (ob?.flow === 'v3') {
    if (ob.phase !== 'complete') {
      await handleV3Message(ctx, athlete);
      return;
    }
  } else {
    const step = typeof ob?.step === 'number' ? ob.step : 0;
    if (step < onboardingSteps.length) {
      await handleOnboardingMessage(ctx, athlete);
      return;
    }
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
    await ctx.reply('Your onboarding is complete — your daily updates start soon.');
    return;
  }

  if (version.status === 'awaiting_paste') {
    await ctx.reply('Your plan is being set up. Daily updates start soon.');
  } else if (version.status === 'active') {
    // Hand the message to the worker: persist it, enqueue a tg_message job, and
    // return fast (Telegram wants a quick 200). The worker runs the agent and
    // sends the reply. The unique key dedups Telegram delivery retries.
    const text = ctx.message?.text ?? '';
    const messageId = ctx.message?.message_id;
    await db.from('messages').insert({
      athlete_id: athlete.id,
      channel: 'tg',
      direction: 'in',
      body: text,
    });
    await enqueueJob('tg_message', `tg-${athlete.id}-${messageId}`, {
      athlete_id: athlete.id,
      text,
    });
    try {
      // Instant "got it" while the worker spins up — the typing indicator
      // (driven by the worker during the agent run) carries the rest.
      await ctx.react('👀');
    } catch (err) {
      // Reaction is cosmetic — never let it break the enqueue/200.
      console.warn('[bot] react failed', err);
    }
  } else {
    await ctx.reply('Your onboarding is complete — your daily updates start soon.');
  }
}

// Transcribes a Telegram voice note and dispatches it exactly like a typed
// message. We write the transcript onto ctx.message.text so every downstream
// path (wellness, onboarding, coaching) picks it up through handleInboundText.
export async function handleInboundVoice(ctx: Context): Promise<void> {
  // Instant acknowledgement while transcription runs (a few seconds).
  try {
    await ctx.react('👀');
  } catch (err) {
    console.warn('[bot] react failed', err);
  }

  let transcript: string;
  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Telegram file download failed (${res.status})`);
    }
    const buf = await res.arrayBuffer();
    transcript = await transcribeOgg(buf);
  } catch (err) {
    console.error('[bot] voice transcription failed', err);
    await ctx.reply('Voice transcription is having trouble right now — mind typing it for now?');
    return;
  }

  if (!transcript) {
    await ctx.reply("Couldn't make out that audio — mind typing it or trying again?");
    return;
  }

  // Inject the transcript so downstream handlers read it as if typed.
  (ctx.message as { text?: string }).text = transcript;
  await handleInboundText(ctx);
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
  await sendAndLog(athlete.id, ctx.chat.id, calendarSubscribeText(url));
}

// Shared by the /calendar command and the onboarding next-action [Add to calendar].
function calendarSubscribeText(url: string): string {
  return [
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
}

// Phase D next-actions, tapped after onboarding is terminal (so they can't route
// through the onboarding dispatcher). Mirrors the [Adjust it] handoff: [Adjust]
// enqueues a coach tg_message; [Add to calendar] surfaces the subscribe URL.
export async function handleNextAction(
  ctx: Context,
  athlete: AthleteRow,
  data: string,
): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.from!.id;

  // Log the tap as an inbound message so the terminal onboarding beat shows in the
  // transcript (these next-actions bypass the onboarding dispatcher's tap logging).
  const msg = ctx.callbackQuery?.message;
  const rows = msg && 'reply_markup' in msg ? msg.reply_markup?.inline_keyboard : undefined;
  await supabaseAdmin()
    .from('messages')
    .insert({
      athlete_id: athlete.id,
      channel: 'tg',
      direction: 'in',
      body: labelForTap(rows, data) ?? data,
    });

  if (data === 'next:calendar') {
    const { url } = await getOrCreateCalendarToken(athlete.id);
    await ctx.answerCallbackQuery();
    await sendAndLog(athlete.id, chatId, calendarSubscribeText(url));
    return;
  }

  if (data === 'next:adjust') {
    // callbackQuery.id keys the dedup so a webhook retry of the same tap enqueues once.
    await enqueueJob('tg_message', `tg_adjust:${athlete.id}:${ctx.callbackQuery?.id ?? 'cb'}`, {
      athlete_id: athlete.id,
      text: "I'd like to adjust my training plan — take a look and let's talk through what to change.",
    });
    await ctx.answerCallbackQuery();
    await sendAndLog(athlete.id, chatId, "On it — I'll take a look and message you in a moment.");
    return;
  }

  if (data === 'next:done') {
    await ctx.answerCallbackQuery();
    await sendAndLog(
      athlete.id,
      chatId,
      "Sounds good. I'll check in with you in the morning — talk then.",
    );
    return;
  }

  await ctx.answerCallbackQuery();
}

// Loads the athlete for a command, or replies with the standard guard message
// and returns null. Mirrors the athlete/onboarding guards used by /checkin and
// /calendar. Used by the two on-demand coaching commands below.
async function loadOnboardedAthlete(ctx: CommandContext<Context>): Promise<AthleteRow | null> {
  const db = supabaseAdmin();
  const { data: athlete } = await db
    .from('athletes')
    .select('*')
    .eq('telegram_chat_id', String(ctx.chat.id))
    .maybeSingle();
  if (!athlete) {
    await ctx.reply('Use your invite link to get started.');
    return null;
  }
  const ob = athlete.onboarding_state as { step?: number } | null;
  if ((typeof ob?.step === 'number' ? ob.step : 0) < onboardingSteps.length) {
    await ctx.reply('Finish onboarding first.');
    return null;
  }
  return athlete;
}

// A coaching run counts as in-flight if there's an uncompleted tg_message or
// daily_checkin job for this athlete enqueued in the last few minutes. The time
// box matters: a job that dies after MAX_ATTEMPTS keeps completed_at null
// (failJob marks it DEAD rather than completing it), so anchoring on age lets a
// dead or stuck run age out instead of locking the athlete out of new commands.
// Every coaching job's key_unique embeds the athlete uuid (e.g. tg_fresh:<id>:…,
// daily-<id>-<date>), so a substring match scopes to the athlete without a
// jsonb-path filter. Fails open — a guard error must never block a real command.
const INFLIGHT_WINDOW_MS = 10 * 60_000;

async function hasInFlightCoachingRun(athleteId: string): Promise<boolean> {
  const since = new Date(Date.now() - INFLIGHT_WINDOW_MS).toISOString();
  const { data, error } = await supabaseAdmin()
    .from('job_queue')
    .select('id')
    .in('kind', ['tg_message', 'daily_checkin'])
    .like('key_unique', `%${athleteId}%`)
    .is('completed_at', null)
    .gte('created_at', since)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('[bot] in-flight coaching check failed:', error.message);
    return false;
  }
  return Boolean(data);
}

// /fresh_update: refresh everything and send a fresh coaching update on demand.
// Enqueues a tg_message; the worker's hydrate() re-fetches Strava and reloads
// memory before the agent runs, so "refresh everything" comes for free.
async function handleFreshUpdateCommand(ctx: CommandContext<Context>): Promise<void> {
  const athlete = await loadOnboardedAthlete(ctx);
  if (!athlete) return;
  if (await hasInFlightCoachingRun(athlete.id)) {
    await ctx.reply(
      "I'm still working on your last one. Give me a moment and I'll be right with you.",
    );
    return;
  }
  const db = supabaseAdmin();
  await db.from('messages').insert({
    athlete_id: athlete.id,
    channel: 'tg',
    direction: 'in',
    body: '/fresh_update',
  });
  await enqueueJob('tg_message', `tg_fresh:${athlete.id}:${ctx.message?.message_id}`, {
    athlete_id: athlete.id,
    text:
      "Give me a fresh update. Pull my latest Strava and tell me where my training's at " +
      "and what's coming up. You don't need to ask me anything right now, just give me the rundown.",
  });
  await sendAndLog(
    athlete.id,
    ctx.chat.id,
    "On it. Pulling your latest data — I'll have an update in a moment.",
  );
}

// /adjust_plan: open a conversation to change the training plan. Same handoff as
// the post-onboarding [Adjust the plan] button; the athlete's free-text replies
// then route through handleInboundText's active-plan branch.
async function handleAdjustPlanCommand(ctx: CommandContext<Context>): Promise<void> {
  const athlete = await loadOnboardedAthlete(ctx);
  if (!athlete) return;
  if (await hasInFlightCoachingRun(athlete.id)) {
    await ctx.reply(
      "I'm still working on your last one. Give me a moment and I'll be right with you.",
    );
    return;
  }
  const db = supabaseAdmin();
  await db.from('messages').insert({
    athlete_id: athlete.id,
    channel: 'tg',
    direction: 'in',
    body: '/adjust_plan',
  });
  await enqueueJob('tg_message', `tg_adjust_cmd:${athlete.id}:${ctx.message?.message_id}`, {
    athlete_id: athlete.id,
    text: "I'd like to adjust my training plan. Take a look and let's talk through what to change.",
  });
  await sendAndLog(
    athlete.id,
    ctx.chat.id,
    "On it. I'll take a look at your plan and message you in a moment.",
  );
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

export async function handleDisconnectStravaCommand(ctx: CommandContext<Context>): Promise<void> {
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

  await db.from('messages').insert({
    athlete_id: athlete.id,
    channel: 'tg',
    direction: 'in',
    body: '/disconnect_strava',
  });

  const { hadConnection } = await disconnectStrava(athlete.id, { revokeOnStrava: true });

  if (!hadConnection) {
    await sendAndLog(athlete.id, ctx.chat.id, "You don't have a Strava connection on file.");
    return;
  }

  await sendAndLog(
    athlete.id,
    ctx.chat.id,
    "Disconnected from Strava and revoked access. I won't see your training anymore — run /connect_strava whenever you want to reconnect.",
  );
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
    _bot.command('disconnect_strava', handleDisconnectStravaCommand);
    _bot.command('strava_status', handleStravaStatusCommand);
    _bot.command('calendar', handleCalendarCommand);
    _bot.command('fresh_update', handleFreshUpdateCommand);
    _bot.command('adjust_plan', handleAdjustPlanCommand);
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
    _bot.on('message:voice', async (ctx) => {
      await handleInboundVoice(ctx);
    });
    _bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;

      // Inert marker on a collapsed "you picked X" button — a re-tap is a no-op.
      if (data === 'noop') {
        await ctx.answerCallbackQuery();
        return;
      }

      const db = supabaseAdmin();
      // Key on the CHAT the button lives in, not the user who tapped. In a private
      // chat these are equal; in a group (test harness) the user id is positive and
      // the athlete is keyed on the negative group chat id, so ctx.from.id would miss.
      const chatId = ctx.chat?.id ?? ctx.from.id;
      const { data: athlete } = await db
        .from('athletes')
        .select('*')
        .eq('telegram_chat_id', String(chatId))
        .maybeSingle();

      if (!athlete) {
        await ctx.answerCallbackQuery();
        return;
      }

      // Phase D next-actions are tapped after onboarding is terminal, so they
      // must be handled before the onboarding-state gate below (which otherwise
      // dismisses every callback once onboarding is complete).
      if (data.startsWith('next:')) {
        await handleNextAction(ctx, athlete, data);
        return;
      }

      // Onboarding v3 chips ('v3:<value>') route to the engine. A v3 athlete
      // never has v2 step callbacks, so dismiss any other tap rather than fall
      // through to the v2 dispatcher.
      const obState = athlete.onboarding_state as { flow?: string } | null;
      if (obState?.flow === 'v3') {
        if (data.startsWith('v3:')) {
          await handleV3Callback(ctx, athlete, data);
        } else {
          await ctx.answerCallbackQuery();
        }
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

let _stagingBot: Bot | null = null;

/**
 * Outbound API selector for the onboarding test harness.
 *
 * A test athlete onboards in a Telegram group (negative chat id) that contains only
 * the staging bot. But the Strava OAuth callback runs on prod Vercel with the *real*
 * bot's token — so a group-bound send (the A1 resume message) would go out from a bot
 * that isn't in the group and never arrive. When STAGING_BOT_TOKEN is set, group
 * (negative) chats are served by the staging bot instead.
 *
 * Real athletes have positive chat ids and always use the primary bot. With
 * STAGING_BOT_TOKEN unset (normal prod), this is a no-op. Mirrors the cron's existing
 * negative-chat-id == test-athlete convention.
 */
export function botApiForChat(chatId: number | string): Bot['api'] {
  const isGroup = String(chatId).startsWith('-');
  const stagingToken = process.env.STAGING_BOT_TOKEN;
  if (isGroup && stagingToken) {
    if (!_stagingBot) _stagingBot = new Bot(stagingToken);
    return _stagingBot.api;
  }
  return getBot().api;
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
  _stagingBot = null;
}
