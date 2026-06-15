/**
 * export-daily-transcripts.ts
 *
 * Exports one day's messages for *every* athlete into a single Markdown file,
 * so you can read the whole roster's conversations for a day in one pass instead
 * of running `npm run transcript` per athlete.
 *
 * Defaults to today (America/Los_Angeles). Pass a YYYY-MM-DD date to read a
 * different day. The day window is computed in PT, so "2026-06-14" means the
 * PT calendar day, not a UTC slice.
 *
 * Athletes are ordered by name. Test athletes (negative telegram_chat_id — the
 * group-chat staging accounts) are skipped, matching the daily-checkin cron.
 * Athletes with no messages that day are omitted.
 *
 * The output lands in transcripts/daily-<date>.md, which is gitignored — these
 * files contain real conversation data and must not be committed.
 *
 * Usage:
 *   npm run transcripts:daily              # today (PT)
 *   npm run transcripts:daily -- 2026-06-14
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
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' });
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Offset (ms) of `TZ` from UTC at the given instant: asUTC(wallClock) - instant. */
function tzOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - instant.getTime();
}

/** UTC instant of midnight (00:00) PT on the given YYYY-MM-DD. */
function ptMidnightUtc(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const naiveUtc = Date.UTC(y, m - 1, d);
  // Offset near the target midnight is stable except across the ~2am DST flip,
  // which we don't sweat for a friends-only reading tool.
  const off = tzOffsetMs(new Date(naiveUtc));
  return new Date(naiveUtc - off);
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  // Normalize via UTC arithmetic, then read back the UTC calendar parts. Do NOT
  // format through a PT formatter here — a UTC-midnight instant renders as the
  // previous PT day and would collapse the day window.
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function main() {
  const arg = process.argv[2]?.trim();
  if (arg && !/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    console.error('Usage: npm run transcripts:daily -- [YYYY-MM-DD]');
    process.exit(1);
  }
  const dateStr = arg || dateKeyFmt.format(new Date());

  const start = ptMidnightUtc(dateStr);
  const end = ptMidnightUtc(addDays(dateStr, 1));

  const db = supabaseAdmin();

  const { data: messages, error: msgErr } = await db
    .from('messages')
    .select('athlete_id, direction, channel, body, sent_at')
    .gte('sent_at', start.toISOString())
    .lt('sent_at', end.toISOString())
    .order('sent_at', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (msgErr) {
    console.error('Error fetching messages:', msgErr.message);
    process.exit(1);
  }

  const weekday = weekdayFmt.format(start);

  if (!messages || messages.length === 0) {
    const outPath = `transcripts/daily-${dateStr}.md`;
    mkdirSync('transcripts', { recursive: true });
    writeFileSync(
      outPath,
      `# Daily transcripts — ${dateStr} (${weekday})\n\n_No messages on this day (${TZ})._\n`,
      'utf8',
    );
    console.log(`No messages on ${dateStr}. Wrote empty transcript to ${outPath}`);
    return;
  }

  const athleteIds = [...new Set(messages.map((m) => m.athlete_id))];

  const { data: athletes, error: athErr } = await db
    .from('athletes')
    .select('id, name, user_id, telegram_chat_id')
    .in('id', athleteIds);
  if (athErr) {
    console.error('Error fetching athletes:', athErr.message);
    process.exit(1);
  }

  const userIds = [...new Set((athletes ?? []).map((a) => a.user_id).filter(Boolean))];
  const { data: users, error: usrErr } = await db
    .from('users')
    .select('id, email')
    .in('id', userIds);
  if (usrErr) {
    console.error('Error fetching users:', usrErr.message);
    process.exit(1);
  }
  const emailById = new Map((users ?? []).map((u) => [u.id, u.email]));

  // Real athletes only, ordered by name. Negative chat_id = group-chat staging
  // accounts (see docs/testing-onboarding.md); drop them like the cron does.
  const roster = (athletes ?? [])
    .filter((a) => !String(a.telegram_chat_id ?? '').startsWith('-'))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  const byAthlete = new Map<string, typeof messages>();
  for (const m of messages) {
    if (!byAthlete.has(m.athlete_id)) byAthlete.set(m.athlete_id, []);
    byAthlete.get(m.athlete_id)!.push(m);
  }

  const lines: string[] = [];
  lines.push(`# Daily transcripts — ${dateStr} (${weekday})`);
  lines.push('');
  lines.push(`_${roster.length} athletes with activity · ${TZ}_`);
  lines.push('');

  let totalRendered = 0;
  for (const a of roster) {
    const msgs = byAthlete.get(a.id) ?? [];
    if (msgs.length === 0) continue;
    totalRendered += msgs.length;

    const email = emailById.get(a.user_id) ?? 'unknown';
    lines.push('---');
    lines.push('');
    lines.push(`## ${a.name} <${email}>`);
    lines.push('');
    lines.push(`_${msgs.length} message${msgs.length === 1 ? '' : 's'}_`);
    lines.push('');

    for (const m of msgs) {
      const at = new Date(m.sent_at);
      const who = m.direction === 'in' ? 'ATHLETE' : 'BOT';
      const channelTag = m.channel === 'tg' ? '' : ` · ${m.channel}`;
      lines.push(`**${who} · ${timeFmt.format(at)}${channelTag}**`);
      lines.push('');
      lines.push(m.body);
      lines.push('');
    }
  }

  const outPath = `transcripts/daily-${dateStr}.md`;
  mkdirSync('transcripts', { recursive: true });
  writeFileSync(outPath, lines.join('\n'), 'utf8');

  console.log(
    `Wrote ${totalRendered} messages across ${roster.length} athletes to ${outPath}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
