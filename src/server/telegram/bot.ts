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
  isOnboarded,
} from './onboarding/index';
import { handleCheckinCommand, handleWellnessMessage, nowInTimezone } from './checkin/dispatcher';
import { selectionKeyboardFromTap } from './onboarding/dispatcher';
import {
  clearAutoInactivityPause,
  pauseAthleteManual,
  resumeAthlete,
  RESUME_AUTO_CALLBACK,
} from './pause';
import { handleV3Message, handleV3Callback } from './onboarding/engine/router';
import { fetchRecentActivities, hasStravaConnection } from '@/server/strava/activities';
import { disconnectStrava } from '@/server/strava/disconnect';
import { disconnectGoogleCalendar } from '@/server/google/disconnect';
import { enqueueCalendarSyncIfConnected } from '@/server/google/enqueue-sync';
import { getOrCreateCalendarToken, getOrCreatePrehabToken } from '@/lib/calendar-token';
import { enqueueJob } from '@/server/jobs/enqueue';
import { transcribeOgg } from '@/lib/transcribe';
import { createTopupSession } from '@/server/billing/checkout';
import { getCreditState } from '@/server/billing/credits';
import { estimateRunwayDays, runwayLabel } from '@/server/billing/burn-rate';
import { TOPUP_PRESETS_CENTS, dollarsLabel, isPresetCents } from '@/server/billing/pricing';
import { helpText } from './commands';

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

export function googleConnectUrl(athleteId: string): string {
  return `${appBaseUrl()}/google/connect?athlete_id=${athleteId}`;
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

  // An athlete who went quiet and got auto-paused is back the moment they send
  // anything — clear the inactivity pause, then handle the message normally. A
  // manual /pause is left intact (clearAutoInactivityPause gates on pause_reason),
  // so a friend can still ask an ad-hoc question while on vacation (§10.5).
  if (await clearAutoInactivityPause(athlete)) {
    athlete.paused_at = null;
    athlete.pause_reason = null;
  }

  // Route to wellness battery if a check-in is in progress.
  // This check must come before the onboarding check — in practice the two
  // states won't coexist, but wellness wins if they ever do.
  const checkinState = athlete.checkin_state as Record<string, unknown> | null;
  if (checkinState?.sub_step) {
    await handleWellnessMessage(ctx, athlete);
    return;
  }

  const ob = athlete.onboarding_state as {
    flow?: string;
    phase?: string;
    step?: number;
    edit_mode?: unknown;
  } | null;

  // Onboarding v3: the engine drives every turn until the plan is generated
  // (phase 'complete'), after which we fall through to the coaching path below.
  // A completed athlete re-enters the engine while an /edit_profile gap-walk is
  // active (edit_mode set), so their answers route to the walk, not the coach.
  if (ob?.flow === 'v3') {
    if (ob.phase !== 'complete' || ob.edit_mode) {
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

  // Resolve the *working* plan version — the live plan, not the newest row.
  // The calendar "Update your calendar?" flow inserts a `proposed` version
  // without moving current_version_id, so an unconfirmed proposal sits as the
  // newest plan_versions row. Ordering by created_at alone would pick it up and
  // dead-end every inbound message (the athlete goes mute, their messages never
  // get persisted or enqueued). Filter to the live statuses so a pending
  // proposal — or superseded/discarded history — is ignored.
  const { data: version } = await db
    .from('plan_versions')
    .select('status')
    .eq('plan_id', plan.id)
    .in('status', ['active', 'awaiting_paste'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!version) {
    console.warn('[bot] athlete has a plan row but no active/awaiting plan_versions row', athlete.id);
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
    // Ad-hoc message while manually paused (§10): the message is answered + debited
    // normally and does NOT flip the daily back on (clearAutoInactivityPause above
    // left a manual pause intact). Append a light reminder so the paused state stays
    // visible. The worker sends the real reply async, so this is a separate inline
    // message — it lands with the 👀, ahead of the coach reply. Only a manual pause
    // gets the reminder: an auto pause was cleared above; an off-ramp dormant athlete
    // has no active plan so never reaches here; and a post-event dormant athlete (v4
    // W3) keeps their finished plan and IS coached here, but stays quiet — naming a
    // new event, not a nudge, is their way back.
    if (athlete.paused_at != null && athlete.pause_reason === 'manual') {
      await sendAndLog(
        athlete.id,
        ctx.chat!.id,
        "Your account is paused. I'll still get back to you on this, but note that you will not receive any proactive messages until you run /resume.",
      );
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

// Telegram delivers an album as one update per item, each sharing a
// media_group_id, but only the first item carries the caption. We only want to
// react once per album, so we remember groups we've already handled and drop the
// repeats. In-memory is enough: album items land within milliseconds while the
// instance is warm; a cold split across serverless instances at worst yields a
// second notice, never fewer. Entries self-expire so the map can't grow without
// bound.
const recentMediaGroups = new Map<string, number>();
const MEDIA_GROUP_TTL_MS = 60_000;

function isDuplicateMediaGroup(mediaGroupId: string | undefined): boolean {
  if (!mediaGroupId) return false;
  const now = Date.now();
  for (const [id, seenAt] of recentMediaGroups) {
    if (now - seenAt > MEDIA_GROUP_TTL_MS) recentMediaGroups.delete(id);
  }
  if (recentMediaGroups.has(mediaGroupId)) return true;
  recentMediaGroups.set(mediaGroupId, now);
  return false;
}

// Unsupported attachments (photos, documents/"send as file", video, stickers,
// GIFs, audio…) have no `text` field, so without this they're dropped silently
// and the bot looks broken. Any caption lives on ctx.message.caption. We can't
// open the attachment, so tell the athlete that and — when there's a caption —
// route it through handleInboundText as if typed, so they still get a real
// reply. Mirrors handleInboundVoice.
export async function handleInboundMedia(ctx: Context): Promise<void> {
  // An album fans out into one update per item; only react to the first.
  if (isDuplicateMediaGroup(ctx.message?.media_group_id)) return;

  const caption = ctx.message?.caption?.trim() ?? '';

  if (!caption) {
    await ctx.reply(
      "I can't open attachments like that yet. Tell me in a message what you needed and I'll pick it up from there.",
    );
    return;
  }

  await ctx.reply("I can't open attachments like that yet, so I'll go off your caption.");
  (ctx.message as { text?: string }).text = caption;
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

  if (!isOnboarded(athlete.onboarding_state as Parameters<typeof isOnboarded>[0])) {
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

  if (!isOnboarded(athlete.onboarding_state as Parameters<typeof isOnboarded>[0])) {
    await ctx.reply('Finish onboarding first.');
    return;
  }

  await db.from('messages').insert({
    athlete_id: athlete.id,
    channel: 'tg',
    direction: 'in',
    body: '/calendar',
  });

  await sendCalendarMessage(athlete.id, ctx.chat.id);
}

// /prehab — the athlete's prehab routine page. Mirrors /calendar. Doesn't
// check whether prehab_program.md exists yet: the page owns the pending state.
export async function handlePrehabCommand(ctx: CommandContext<Context>): Promise<void> {
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

  if (!isOnboarded(athlete.onboarding_state as Parameters<typeof isOnboarded>[0])) {
    await ctx.reply('Finish onboarding first.');
    return;
  }

  await db.from('messages').insert({
    athlete_id: athlete.id,
    channel: 'tg',
    direction: 'in',
    body: '/prehab',
  });

  const { url } = await getOrCreatePrehabToken(athlete.id);
  await sendAndLog(athlete.id, chatId, `Your prehab routine: ${url}`);
}

// Shared by the /calendar command and the onboarding next-action [Add to calendar].
// Two paths to a synced calendar: Google OAuth direct-write (real-time, one tap)
// and the ICS subscribe link for everyone else (Specs/CALENDAR_OAUTH.md). Rather
// than explain both up front, ask which calendar they use — the Google button
// links out to connect, the other tap answers with the subscribe link
// (handleCalendarPick). An existing Google ICS subscription keeps working —
// connecting is opt-in.
async function sendCalendarMessage(athleteId: string, chatId: number | string): Promise<void> {
  const { data: googleRow } = await supabaseAdmin()
    .from('oauth_tokens')
    .select('id')
    .eq('athlete_id', athleteId)
    .eq('provider', 'google_calendar')
    .maybeSingle();

  if (googleRow) {
    const { url } = await getOrCreateCalendarToken(athleteId);
    await sendAndLog(
      athleteId,
      chatId,
      [
        'Google Calendar: connected. Your "Daybreak — training" calendar updates on its own — plan changes land within seconds.',
        '',
        'On another device (Apple Calendar, Outlook), subscribe to this link:',
        url,
        '',
        'Run /disconnect_calendar to disconnect Google.',
      ].join('\n'),
    );
    return;
  }

  const text = 'Which calendar do you use?';
  const keyboard = new InlineKeyboard()
    .url('Google Calendar', googleConnectUrl(athleteId))
    .row()
    .text('Apple Calendar, Outlook, anything else', 'calpick:ics');
  await getBot().api.sendMessage(chatId, text, { reply_markup: keyboard });
  await supabaseAdmin().from('messages').insert({
    athlete_id: athleteId,
    channel: 'tg',
    direction: 'out',
    body: text,
  });
}

// The "Apple Calendar, Outlook, anything else" tap from the calendar picker —
// answers with the ICS subscribe link. The Google button on the same keyboard
// is a URL button and never reaches the webhook.
export async function handleCalendarPick(
  ctx: Context,
  athlete: AthleteRow,
  data: string,
): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.from!.id;

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

  await ctx.answerCallbackQuery();

  const { url } = await getOrCreateCalendarToken(athlete.id);
  await sendAndLog(
    athlete.id,
    chatId,
    [
      'Subscribe to this link:',
      url,
      '',
      'Apple Calendar — File → New Calendar Subscription → paste URL',
      'Outlook — Add calendar → Subscribe from web → paste URL',
      '',
      'Workouts appear on their day and update automatically when your plan changes.',
    ].join('\n'),
  );
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
    await ctx.answerCallbackQuery();
    await sendCalendarMessage(athlete.id, chatId);
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

// The "Turn daily check-ins back on" button on the auto-pause notice (§10.5).
// Clears the inactivity pause, collapses the button so it can't re-fire, and
// enqueues today's check-in so coming back feels live rather than "tomorrow."
export async function handleResumeAuto(ctx: Context, athlete: AthleteRow): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.from!.id;

  await supabaseAdmin()
    .from('athletes')
    .update({ paused_at: null, pause_reason: null })
    .eq('id', athlete.id);

  // Log the tap as inbound — it's the athlete re-engaging.
  const msg = ctx.callbackQuery?.message;
  const rows = msg && 'reply_markup' in msg ? msg.reply_markup?.inline_keyboard : undefined;
  await supabaseAdmin().from('messages').insert({
    athlete_id: athlete.id,
    channel: 'tg',
    direction: 'in',
    body: labelForTap(rows, RESUME_AUTO_CALLBACK) ?? RESUME_AUTO_CALLBACK,
  });

  await ctx.answerCallbackQuery();

  // Collapse the tapped keyboard to a "✅ <choice>" record so it can't repeat.
  const collapsed = selectionKeyboardFromTap(rows, RESUME_AUTO_CALLBACK);
  if (collapsed) {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: collapsed });
    } catch (err) {
      console.warn('[bot] resume button collapse failed', err);
    }
  }

  await sendAndLog(athlete.id, chatId, "Back on. I'll check in with you in the morning.");

  // Enqueue today's check-in now; the per-day key dedups if one already exists.
  const { date } = nowInTimezone(athlete.timezone);
  await enqueueJob('daily_checkin', `daily-${athlete.id}-${date}`, { athlete_id: athlete.id });
}

// Calendar-confirm taps (Specs/CALENDAR_CONFIRM.md). The worker stages a coach
// plan edit as a 'proposed' plan_versions row and sends a confirm keyboard;
// the tap lands here. Yes promotes the candidate to active (the calendar moves),
// No discards it. No agent run on either path. Idempotency lives in the RPCs —
// a cleared/mismatched token resolves to 'not_found', not an error — plus the
// message edit below, which removes the keyboard so the tap can't repeat.
export async function handleCalendarConfirm(
  ctx: Context,
  athlete: AthleteRow,
  data: string,
): Promise<void> {
  const match = /^cal:(y|n):(.+)$/.exec(data);
  if (!match) {
    await ctx.answerCallbackQuery();
    return;
  }
  const action = match[1] as 'y' | 'n';
  const token = match[2]!;

  const msg = ctx.callbackQuery?.message;
  const rows = msg && 'reply_markup' in msg ? msg.reply_markup?.inline_keyboard : undefined;
  const db = supabaseAdmin();
  await db.from('messages').insert({
    athlete_id: athlete.id,
    channel: 'tg',
    direction: 'in',
    body: labelForTap(rows, data) ?? data,
  });

  const { data: plan } = await db
    .from('plans')
    .select('id')
    .eq('athlete_id', athlete.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!plan) {
    await ctx.answerCallbackQuery();
    return;
  }

  const { data: result, error } =
    action === 'y'
      ? await db.rpc('promote_proposed_version', { p_plan_id: plan.id, p_token: token })
      : await db.rpc('discard_proposed_version', { p_plan_id: plan.id, p_token: token });

  if (error) {
    console.error('[cal] confirm tap failed', `athlete=${athlete.id}`, error);
    // Leave the keyboard in place so the athlete can re-tap once we're healthy.
    await ctx
      .answerCallbackQuery({ text: 'Something went wrong — try again in a moment.' })
      .catch(() => undefined);
    return;
  }

  // A promoted version is the active plan changing — push it to the athlete's
  // Google calendar if they have one. Best-effort inside; the ICS feed picks
  // up the change regardless.
  if (action === 'y' && result === 'promoted') {
    await enqueueCalendarSyncIfConnected(athlete.id, 'promotion');
  }

  const resolvedLine =
    result === 'promoted'
      ? '✓ Calendar updated.'
      : result === 'discarded'
        ? 'Left as-is.'
        : result === 'expired' || result === 'stale'
          ? 'This one expired — ask me again if you still want the change.'
          : 'Already handled.';

  await ctx.answerCallbackQuery();

  // Resolve the button message in place: keep the proposal text for context,
  // append the outcome, drop the keyboard (an edit without reply_markup clears it).
  const original = msg && 'text' in msg ? msg.text : undefined;
  await ctx
    .editMessageText(original ? `${original}\n\n${resolvedLine}` : resolvedLine)
    .catch(() => undefined);

  await db.from('messages').insert({
    athlete_id: athlete.id,
    channel: 'tg',
    direction: 'out',
    body: resolvedLine,
  });
}

// Loads the athlete for a command, or replies with the standard guard message
// and returns null. Mirrors the athlete/onboarding guards used by /checkin and
// /calendar. Used by the on-demand coaching commands below.
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
  if (
    !isOnboarded(
      athlete.onboarding_state as { flow?: string; phase?: string; step?: number } | null,
    )
  ) {
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

// /edit_profile: the persistent affordance the v3 orientation promises ("you can
// always edit your profile in the menu later"). A v3 athlete gets a fork —
// "Update something" (say anything; it's folded in mid-onboarding by the engine,
// or handled by the coach once onboarding's done) or "Finish my profile" (walk
// the open known-gaps, W3.2). Works during and after onboarding. A v2 athlete has
// no slot engine, so it degrades to a plain "just tell me" prompt.
async function handleEditProfileCommand(ctx: CommandContext<Context>): Promise<void> {
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
  await db
    .from('messages')
    .insert({ athlete_id: athlete.id, channel: 'tg', direction: 'in', body: '/edit_profile' });

  const ob = athlete.onboarding_state as { flow?: string } | null;
  if (ob?.flow === 'v3') {
    const prompt = 'What would you like to do?';
    const kb = new InlineKeyboard()
      .text('Update something', 'v3:edit:update')
      .row()
      .text('Finish my profile', 'v3:edit:finish');
    await ctx.reply(prompt, { reply_markup: kb });
    await db
      .from('messages')
      .insert({ athlete_id: athlete.id, channel: 'tg', direction: 'out', body: prompt });
    return;
  }

  await sendAndLog(
    athlete.id,
    ctx.chat.id,
    "Tell me what you'd like to change and I'll take care of it.",
  );
}

// /balance — dollars left + runway at the athlete's pace (Specs/METERING_PAYMENTS.md
// §9). Comped friends see "on the house"; a paused athlete gets the pause state
// prepended. No agent run, so no in-flight guard. Auto-reload line is step 6.
async function handleBalanceCommand(ctx: CommandContext<Context>): Promise<void> {
  const athlete = await loadOnboardedAthlete(ctx);
  if (!athlete) return;
  const db = supabaseAdmin();
  await db
    .from('messages')
    .insert({ athlete_id: athlete.id, channel: 'tg', direction: 'in', body: '/balance' });

  const state = await getCreditState(athlete.id);

  let body: string;
  if (!state) {
    // Shouldn't happen post-onboarding (the $5 grant writes the row), but don't crash.
    body = 'No credit on file yet — /buy to add some.';
  } else if (state.comped) {
    body = "You're on the house — no credit needed.";
  } else if (state.balanceCents <= 0) {
    body = "You're out of credit. /buy to add more.";
  } else {
    const days = await estimateRunwayDays(state.balanceCents, athlete.id);
    body = `${dollarsLabel(state.balanceCents)} left — ${runwayLabel(days)} at your pace.`;
  }

  const prefix = athlete.paused_at ? 'Your daily check-ins are paused right now.\n\n' : '';
  await sendAndLog(athlete.id, ctx.chat.id, prefix + body);
}

// /buy — the preset top-up flow (§6). Sends three amount buttons; the tap lands in
// handleBuy below, which mints the Stripe link.
async function handleBuyCommand(ctx: CommandContext<Context>): Promise<void> {
  const athlete = await loadOnboardedAthlete(ctx);
  if (!athlete) return;
  const db = supabaseAdmin();
  await db
    .from('messages')
    .insert({ athlete_id: athlete.id, channel: 'tg', direction: 'in', body: '/buy' });

  const text = 'How much do you want to add?';
  const keyboard = new InlineKeyboard();
  // Presets are short ($10 · $25 · $50), so one row reads fine and labels never truncate.
  for (const cents of TOPUP_PRESETS_CENTS) keyboard.text(dollarsLabel(cents), `buy:${cents}`);

  await getBot().api.sendMessage(ctx.chat.id, text, { reply_markup: keyboard });
  await db
    .from('messages')
    .insert({ athlete_id: athlete.id, channel: 'tg', direction: 'out', body: text });
}

// A "$10/$25/$50" tap from /buy. Mints a Stripe Checkout Session in-process and hands
// back the hosted-page link. On success the keyboard collapses to a ✅ record so the
// tap can't repeat; on failure the buttons stay live for a retry.
export async function handleBuy(ctx: Context, athlete: AthleteRow, data: string): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.from!.id;
  const cents = Number(data.slice('buy:'.length));

  // Log the tap as inbound (the amount the friend chose).
  const msg = ctx.callbackQuery?.message;
  const rows = msg && 'reply_markup' in msg ? msg.reply_markup?.inline_keyboard : undefined;
  await supabaseAdmin().from('messages').insert({
    athlete_id: athlete.id,
    channel: 'tg',
    direction: 'in',
    body: labelForTap(rows, data) ?? data,
  });

  await ctx.answerCallbackQuery();

  if (!isPresetCents(cents)) {
    // Stale or tampered callback — nothing to do.
    return;
  }

  try {
    const url = await createTopupSession(athlete.id, cents);

    // Collapse the keyboard only once we have a link, so a failed mint leaves the
    // presets tappable for a retry.
    const collapsed = selectionKeyboardFromTap(rows, data);
    if (collapsed) {
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: collapsed });
      } catch (err) {
        console.warn('[bot] buy button collapse failed', err);
      }
    }

    await sendAndLog(
      athlete.id,
      chatId,
      `Here's your checkout for ${dollarsLabel(cents)}. Pay there and I'll confirm back here:\n${url}`,
    );
  } catch (err) {
    console.error('[bot] createTopupSession failed', `athlete=${athlete.id}`, err);
    await sendAndLog(
      athlete.id,
      chatId,
      "I couldn't start checkout just now — ping David and he'll sort it out.",
    );
  }
}

// /pause — stop the proactive daily check-in indefinitely (§10). Thin wrapper over
// pauseAthleteManual; the cron's `paused_at != null` filter does the actual work.
// No agent run, so no in-flight guard. Already-paused replies idempotently.
async function handlePauseCommand(ctx: CommandContext<Context>): Promise<void> {
  const athlete = await loadOnboardedAthlete(ctx);
  if (!athlete) return;
  const db = supabaseAdmin();
  await db
    .from('messages')
    .insert({ athlete_id: athlete.id, channel: 'tg', direction: 'in', body: '/pause' });

  const result = await pauseAthleteManual(athlete);
  const body =
    result === 'paused'
      ? "Done — your daily check-ins are off until you run /resume. Message me anytime in the meantime and I'll still answer."
      : 'Your daily check-ins are already off. Run /resume when you want them back.';
  await sendAndLog(athlete.id, ctx.chat.id, body);
}

// /resume — clear the pause and pull today's check-in forward so coming back is
// live (§10). resumeAthlete enqueues the daily job idempotently on the per-day key.
// Not-paused replies idempotently.
async function handleResumeCommand(ctx: CommandContext<Context>): Promise<void> {
  const athlete = await loadOnboardedAthlete(ctx);
  if (!athlete) return;
  const db = supabaseAdmin();
  await db
    .from('messages')
    .insert({ athlete_id: athlete.id, channel: 'tg', direction: 'in', body: '/resume' });

  const result = await resumeAthlete(athlete);
  if (result === 'not_paused') {
    await sendAndLog(
      athlete.id,
      ctx.chat.id,
      'Your daily check-ins are already on — nothing to resume.',
    );
    return;
  }

  // Coming back should feel live: kick off a fresh check-in now. Key it per /resume
  // (message_id), NOT the cron's daily-{id}-{date} key — that key already exists on
  // any day the morning run fired, so reusing it silently dedups (ignoreDuplicates)
  // and nothing arrives. resumeAthlete's paused→active gate means only the resuming
  // /resume reaches here (a repeat returns 'not_paused'), so this is one run per
  // resume — the cost David accepted.
  await enqueueJob('daily_checkin', `daily-resume-${athlete.id}-${ctx.message?.message_id}`, {
    athlete_id: athlete.id,
  });
  await sendAndLog(
    athlete.id,
    ctx.chat.id,
    "Back on. I'll pull your latest and have an update for you shortly.",
  );
}

// /help — what the bot can do + the §9 credits disclosure. Reads the same catalog the
// BotFather menu does (commands.ts), so the two never drift. Works for anyone, even
// pre-link (no athlete row → reply without logging).
async function handleHelpCommand(ctx: CommandContext<Context>): Promise<void> {
  const db = supabaseAdmin();
  const { data: athlete } = await db
    .from('athletes')
    .select('id')
    .eq('telegram_chat_id', String(ctx.chat.id))
    .maybeSingle();

  const text = helpText();
  if (athlete) {
    await db
      .from('messages')
      .insert({ athlete_id: athlete.id, channel: 'tg', direction: 'in', body: '/help' });
    await sendAndLog(athlete.id, ctx.chat.id, text);
  } else {
    await ctx.reply(text);
  }
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

export async function handleDisconnectCalendarCommand(ctx: CommandContext<Context>): Promise<void> {
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
    body: '/disconnect_calendar',
  });

  const { hadConnection, calendarDeleted } = await disconnectGoogleCalendar(athlete.id);

  if (!hadConnection) {
    await sendAndLog(
      athlete.id,
      ctx.chat.id,
      "You don't have Google Calendar connected. If you subscribed by link, that runs without a connection — nothing to disconnect.",
    );
    return;
  }

  await sendAndLog(
    athlete.id,
    ctx.chat.id,
    calendarDeleted
      ? 'Disconnected. The "Daybreak — training" calendar is gone from your Google account. Run /calendar whenever you want it back — or grab the subscribe link there instead.'
      : 'Disconnected on my side. I couldn\'t remove the "Daybreak — training" calendar from your Google account (the connection was already dead) — you can delete it in Google Calendar settings. Run /calendar to set it up again.',
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
      const obState = athlete.onboarding_state as {
        flow?: string;
        phase?: string;
        step?: number;
      } | null;
      if (!isOnboarded(obState)) {
        await ctx.reply('Finish onboarding first.');
        return;
      }
      await handleCheckinCommand(ctx, athlete);
    });
    _bot.command('connect_strava', handleConnectStravaCommand);
    _bot.command('disconnect_strava', handleDisconnectStravaCommand);
    _bot.command('disconnect_calendar', handleDisconnectCalendarCommand);
    _bot.command('strava_status', handleStravaStatusCommand);
    _bot.command('calendar', handleCalendarCommand);
    _bot.command('prehab', handlePrehabCommand);
    _bot.command('fresh_update', handleFreshUpdateCommand);
    _bot.command('adjust_plan', handleAdjustPlanCommand);
    _bot.command('edit_profile', handleEditProfileCommand);
    _bot.command('balance', handleBalanceCommand);
    _bot.command('buy', handleBuyCommand);
    _bot.command('pause', handlePauseCommand);
    _bot.command('resume', handleResumeCommand);
    _bot.command('help', handleHelpCommand);
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
    _bot.on(
      [
        'message:photo',
        'message:document', // includes images sent as a file
        'message:video',
        'message:video_note',
        'message:animation', // GIFs
        'message:audio',
        'message:sticker',
      ],
      async (ctx) => {
        await handleInboundMedia(ctx);
      },
    );
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

      // The auto-pause resume button: its own confirmation + immediate check-in.
      if (data === RESUME_AUTO_CALLBACK) {
        await handleResumeAuto(ctx, athlete);
        return;
      }

      // Any other tap from an auto-paused athlete also counts as re-engagement —
      // wake them, then let the tap route normally (§10.5).
      await clearAutoInactivityPause(athlete);

      // Phase D next-actions are tapped after onboarding is terminal, so they
      // must be handled before the onboarding-state gate below (which otherwise
      // dismisses every callback once onboarding is complete).
      if (data.startsWith('next:')) {
        await handleNextAction(ctx, athlete, data);
        return;
      }

      // Calendar-confirm taps arrive long after onboarding is terminal, so they
      // also route ahead of the onboarding-state gates below.
      if (data.startsWith('cal:')) {
        await handleCalendarConfirm(ctx, athlete, data);
        return;
      }

      // Calendar-picker taps (the Apple/Outlook/other button on /calendar) —
      // same post-onboarding routing as cal: above.
      if (data.startsWith('calpick:')) {
        await handleCalendarPick(ctx, athlete, data);
        return;
      }

      // Top-up amount taps from /buy — post-onboarding, so ahead of the gates below.
      if (data.startsWith('buy:')) {
        await handleBuy(ctx, athlete, data);
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

// Webhook-registration health, distinct from pingTelegram's getMe (token validity).
// getMe stays green even when no webhook is registered, so the bot can be silently
// deaf to every update while /api/health reports telegram: ok — exactly the failure
// that went unnoticed once. The health check reads url (empty == unregistered),
// last_error_message (Telegram's delivery failures), and pending_update_count.
export async function pingTelegramWebhook(): Promise<{
  url: string;
  pending_update_count: number;
  last_error_message?: string;
  last_error_date?: number;
  latency_ms: number;
}> {
  const start = Date.now();
  const info = await getBot().api.getWebhookInfo();
  return {
    url: info.url ?? '',
    pending_update_count: info.pending_update_count ?? 0,
    last_error_message: info.last_error_message,
    last_error_date: info.last_error_date,
    latency_ms: Date.now() - start,
  };
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
