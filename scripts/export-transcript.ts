/**
 * export-transcript.ts
 *
 * Exports a single athlete's full message history as a readable Markdown
 * transcript — the back-and-forth in order, grouped by day, so you can read it
 * as if you were watching the conversation happen (or paste it into Claude to
 * learn from it).
 *
 * Athletes are looked up by email (users.email -> athletes.user_id; the athletes
 * table has no email column). Times are rendered in America/Los_Angeles.
 *
 * The output lands in transcripts/<email>.md, which is gitignored — these files
 * contain real conversation data and must not be committed.
 *
 * Usage: npm run transcript -- <athlete_email>
 */

import { mkdirSync, writeFileSync } from 'fs';
import { config } from 'dotenv';
config({ path: '.env.local' });

import { supabaseAdmin } from '../src/lib/db';

const TZ = 'America/Los_Angeles';

const dateKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error('Usage: npm run transcript -- <athlete_email>');
    process.exit(1);
  }

  const db = supabaseAdmin();

  // Email lives on users; athletes joins via user_id (athletes has no email column).
  const { data: user, error: userErr } = await db
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (userErr) {
    console.error('Error looking up user:', userErr.message);
    process.exit(1);
  }
  if (!user) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  const { data: athlete, error: athleteErr } = await db
    .from('athletes')
    .select('id, name')
    .eq('user_id', user.id)
    .maybeSingle();

  if (athleteErr) {
    console.error('Error looking up athlete:', athleteErr.message);
    process.exit(1);
  }
  if (!athlete) {
    console.error(
      `No athlete found for user ${email}. Has the athlete completed Telegram linking?`,
    );
    process.exit(1);
  }

  const { data: messages, error: msgErr } = await db
    .from('messages')
    .select('direction, channel, body, sent_at')
    .eq('athlete_id', athlete.id)
    .order('sent_at', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (msgErr) {
    console.error('Error fetching messages:', msgErr.message);
    process.exit(1);
  }
  if (!messages || messages.length === 0) {
    console.error(`No messages found for ${athlete.name} (${athlete.id}).`);
    process.exit(1);
  }

  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];
  if (!firstMsg || !lastMsg) {
    console.error(`No messages found for ${athlete.name} (${athlete.id}).`);
    process.exit(1);
  }

  const lines: string[] = [];
  const first = new Date(firstMsg.sent_at);
  const last = new Date(lastMsg.sent_at);

  lines.push(`# Conversation — ${athlete.name} <${email}>`);
  lines.push('');
  lines.push(
    `_${messages.length} messages · ${dateKeyFmt.format(first)} → ${dateKeyFmt.format(last)} ` +
      `(${TZ}) · athlete_id ${athlete.id}_`,
  );
  lines.push('');

  let currentDay = '';
  for (const m of messages) {
    const at = new Date(m.sent_at);
    const dayKey = dateKeyFmt.format(at);

    if (dayKey !== currentDay) {
      currentDay = dayKey;
      lines.push(`## ${dayKey} (${weekdayFmt.format(at)})`);
      lines.push('');
    }

    const who = m.direction === 'in' ? 'ATHLETE' : 'BOT';
    const channelTag = m.channel === 'tg' ? '' : ` · ${m.channel}`;
    lines.push(`**${who} · ${timeFmt.format(at)}${channelTag}**`);
    lines.push('');
    lines.push(m.body);
    lines.push('');
  }

  const safe = email.replace(/[^a-z0-9._-]/gi, '_');
  const outPath = `transcripts/${safe}.md`;
  mkdirSync('transcripts', { recursive: true });
  writeFileSync(outPath, lines.join('\n'), 'utf8');

  console.log(`Wrote ${messages.length} messages to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
