// Model A/B eval for the coaching agent — Haiku 4.5 vs Sonnet 4.6, across the
// three run categories (daily check-in, post-activity, interactive reply). This
// is the gate in Specs/METERING_PAYMENTS.md §14 ("The A/B that gates the
// default") and Phase 0 of Specs/EVAL_HARNESS.md.
//
// What it does: for each sampled athlete × each category, hydrate the athlete's
// real folder ONCE and run the agent twice — Haiku and Sonnet — against
// byte-identical copies of that folder with the same system + user prompt. Only
// the model differs. It captures each side's reply + cost/tokens/turns and emits
// a side-by-side markdown report with per-category cost summaries.
//
// READ-ONLY against prod. It makes real Anthropic API spend (a few dollars) and
// reads real memory_files + live Strava, but writes nothing back: no Telegram
// sends, no agent_runs rows, no credit draw-down, no memory/plan persistence.
// (worker/dry-run-agent.ts stops at the reply — see its header.)
//
//   npx tsx scripts/ab-model-eval.ts                 # default sample, both models
//   npx tsx scripts/ab-model-eval.ts --quick         # David only, 1 input/category
//   npx tsx scripts/ab-model-eval.ts --real 3        # 3 real inbound msgs/athlete
//   npx tsx scripts/ab-model-eval.ts --athlete a@b.c # override the athlete set
//
// --judge (a blind Opus scorer) is a deliberate later add — the human
// side-by-side is the real voice gate (decision: side-by-side first). The
// summary marks where it would slot in.

import { config } from 'dotenv';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

config({ path: '.env.local' });

// hydrate() writes to ATHLETE_ROOT/<athleteId>; the prod default (/data/athletes)
// doesn't exist locally. Point it at a throwaway tmp base BEFORE any worker
// module loads config.ts (which reads ATHLETE_ROOT at import time) — hence the
// dynamic import of the worker pieces inside main().
process.env.ATHLETE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'ab-eval-root-'));

import { supabaseAdmin } from '@/lib/db';

const HAIKU = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-4-6';

// The confirmed sample (David + Brenden + Ian + Chase). --athlete <email> flags
// replace this set entirely.
const DEFAULT_ATHLETES: Array<{ name: string; id: string }> = [
  { name: 'David', id: '6182da86-aafb-4d44-a4bc-ad52e8397c9d' },
  { name: 'Brenden', id: 'fde65f1e-7ba4-4816-8052-f6e0ebc27528' },
  { name: 'Ian', id: '20d3574f-3f74-47ef-9a0a-3f9c8bf58236' },
  { name: 'Chase', id: '8453f462-1b18-44aa-ba2a-c4e256ca2e29' },
];

// Curated canonical questions — the high-stakes interactive cases, identical
// across athletes so the comparison is clean. Per the §14 sample: an injury
// question, a plan-change request, a "should I run today?".
const CURATED_QUESTIONS: Array<{ tag: string; text: string }> = [
  {
    tag: 'injury',
    text: "My knee's been sore the last couple days, especially going down stairs. Should I be worried, and what should I do about tomorrow's run?",
  },
  {
    tag: 'plan-change',
    text: "Can we bump my long run this weekend up to 20 miles? I'm feeling good and want a confidence boost before race day.",
  },
  {
    tag: 'should-i-run',
    text: "Didn't sleep well and my legs feel flat. Should I still do today's run or take it easy?",
  },
];

// Telegram button-tap payloads that land in messages as inbound bodies but aren't
// real questions — excluded from the "real inbound" interactive sample.
const BUTTON_TAPS = new Set(
  [
    'yes, update',
    'no, leave it',
    'turn daily check-ins back on',
    'yes',
    'no',
    'connect strava',
  ].map((s) => s.toLowerCase()),
);

const MIN_REAL_MSG_LEN = 15;

type Args = {
  athleteEmails: string[];
  realCount: number;
  quick: boolean;
  proactiveOnly: boolean;
  models: string[];
};

function parseArgs(argv: string[]): Args {
  const athleteEmails: string[] = [];
  let realCount = 2;
  let quick = false;
  let proactiveOnly = false;
  let models = [HAIKU, SONNET];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--athlete') athleteEmails.push((argv[++i] ?? '').trim().toLowerCase());
    else if (a === '--real') realCount = Math.max(0, Number(argv[++i] ?? 2) || 0);
    else if (a === '--quick') quick = true;
    else if (a === '--proactive-only') proactiveOnly = true;
    else if (a === '--models') models = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  return { athleteEmails, realCount, quick, proactiveOnly, models };
}

async function resolveAthletes(emails: string[]): Promise<Array<{ name: string; id: string }>> {
  const db = supabaseAdmin();
  const out: Array<{ name: string; id: string }> = [];
  for (const email of emails) {
    const { data: user } = await db.from('users').select('id').eq('email', email).maybeSingle();
    if (!user) {
      console.warn(`! no user for ${email} — skipping`);
      continue;
    }
    const { data: athlete } = await db
      .from('athletes')
      .select('id, name')
      .eq('user_id', user.id)
      .maybeSingle();
    if (!athlete) {
      console.warn(`! no athlete for ${email} — skipping`);
      continue;
    }
    out.push({ name: athlete.name ?? email, id: athlete.id });
  }
  return out;
}

// Most-recent real inbound questions for an athlete: non-command, not a button
// tap, of some substance, newest first. The most-recent N are inherently
// post-onboarding. Sparse history just yields fewer — the curated set always
// runs too, so the category is never empty.
async function realInboundQuestions(
  athleteId: string,
  n: number,
): Promise<Array<{ tag: string; text: string }>> {
  if (n <= 0) return [];
  const { data } = await supabaseAdmin()
    .from('messages')
    .select('body, created_at')
    .eq('athlete_id', athleteId)
    .eq('channel', 'tg')
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(60);
  const picked: Array<{ tag: string; text: string }> = [];
  for (const m of data ?? []) {
    const body = typeof m.body === 'string' ? m.body.trim() : '';
    if (!body || body.startsWith('/')) continue;
    if (BUTTON_TAPS.has(body.toLowerCase())) continue;
    if (body.length < MIN_REAL_MSG_LEN) continue;
    picked.push({ tag: `real ${String(m.created_at).slice(0, 10)}`, text: body });
    if (picked.length >= n) break;
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

type Pair = {
  athlete: string;
  category: string;
  inputLabel: string;
  inputText?: string;
  // model id -> result
  results: Record<string, import('../worker/dry-run-agent').DryRunResult>;
};

const CATEGORY_TITLES: Record<string, string> = {
  daily_checkin: 'Daily check-in (proactive)',
  post_activity: 'Post-activity (proactive)',
  tg_message: 'Interactive reply',
};

function money(n: number | null | undefined): string {
  if (n == null) return '—';
  return `$${n.toFixed(4)}`;
}

function intOr(n: number | null | undefined): string {
  return n == null ? '—' : String(n);
}

function quote(text: string): string {
  const t = text.trim();
  if (!t) return '> _(no reply — see error)_';
  return t
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

function metricsTable(pair: Pair, models: string[]): string {
  const rows = [
    ['Model', ...models.map((m) => modelShort(m))],
    ['Cost (raw)', ...models.map((m) => money(pair.results[m]?.costUsd))],
    ['Input tok', ...models.map((m) => intOr(pair.results[m]?.inputTokens))],
    ['Output tok', ...models.map((m) => intOr(pair.results[m]?.outputTokens))],
    ['Cache read tok', ...models.map((m) => intOr(pair.results[m]?.cacheReadInputTokens))],
    ['Turns', ...models.map((m) => intOr(pair.results[m]?.numTurns))],
    [
      'Plan edit',
      ...models.map((m) => {
        const r = pair.results[m];
        if (!r) return '—';
        return r.planFileChanged ? 'changed' : r.planEditAttempted ? 'attempted' : 'no';
      }),
    ],
    ['Status', ...models.map((m) => pair.results[m]?.error ? 'ERROR' : (pair.results[m]?.resultSubtype ?? '—'))],
  ];
  const header = rows[0]!;
  const head = `| ${header.join(' | ')} |`;
  const sep = `| ${header.map(() => '---').join(' | ')} |`;
  const body = rows.slice(1).map((r) => `| ${r.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

function modelShort(m: string): string {
  if (m.includes('haiku')) return 'Haiku';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('opus')) return 'Opus';
  return m;
}

function avg(nums: Array<number | null | undefined>): number | null {
  const xs = nums.filter((n): n is number => typeof n === 'number');
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function categoryCostSummary(pairs: Pair[], models: string[]): string {
  const cats = ['daily_checkin', 'post_activity', 'tg_message'];
  const lines: string[] = [];
  lines.push(`| Category | ${models.map(modelShort).map((m) => `avg raw $/run (${m})`).join(' | ')} | Haiku/Sonnet |`);
  lines.push(`| --- | ${models.map(() => '---').join(' | ')} | --- |`);
  const catAvg: Record<string, Record<string, number | null>> = {};
  for (const cat of cats) {
    const inCat = pairs.filter((p) => p.category === cat);
    if (inCat.length === 0) continue;
    catAvg[cat] = {};
    const cells: string[] = [];
    for (const m of models) {
      const a = avg(inCat.map((p) => p.results[m]?.costUsd ?? null));
      catAvg[cat][m] = a;
      cells.push(a == null ? '—' : money(a));
    }
    const h = catAvg[cat][HAIKU];
    const s = catAvg[cat][SONNET];
    const ratio = h != null && s != null && s > 0 ? `${(h / s).toFixed(2)}×` : '—';
    lines.push(`| ${CATEGORY_TITLES[cat]} | ${cells.join(' | ')} | ${ratio} |`);
  }
  return lines.join('\n') + '\n\n' + tierBurnProjection(catAvg);
}

// Scales the §2 measured friends-only baseline ($0.53 raw/day at Sonnet-both,
// split 38/19/41 across daily/post/interactive per §14) by THIS run's measured
// per-category Haiku/Sonnet cost ratios, to refine §14's tier-burn estimates.
// Planning numbers only — the ledger records the truth.
function tierBurnProjection(catAvg: Record<string, Record<string, number | null>>): string {
  const BASELINE_RAW_PER_DAY = 0.53;
  const SHARE = { daily_checkin: 0.38, post_activity: 0.19, tg_message: 0.41 };
  const sonnetRaw = {
    daily_checkin: BASELINE_RAW_PER_DAY * SHARE.daily_checkin,
    post_activity: BASELINE_RAW_PER_DAY * SHARE.post_activity,
    tg_message: BASELINE_RAW_PER_DAY * SHARE.tg_message,
  };
  const ratio = (cat: keyof typeof SHARE): number => {
    const h = catAvg[cat]?.[HAIKU];
    const s = catAvg[cat]?.[SONNET];
    return h != null && s != null && s > 0 ? h / s : 1;
  };
  const haikuRaw = {
    daily_checkin: sonnetRaw.daily_checkin * ratio('daily_checkin'),
    post_activity: sonnetRaw.post_activity * ratio('post_activity'),
    tg_message: sonnetRaw.tg_message * ratio('tg_message'),
  };
  const billed = (raw: number) => raw * 1.5;
  // Saver = Haiku both; Standard-today = Sonnet both; Standard-proposed = Haiku
  // proactive (daily+post) / Sonnet interactive.
  const saver = haikuRaw.daily_checkin + haikuRaw.post_activity + haikuRaw.tg_message;
  const stdToday = sonnetRaw.daily_checkin + sonnetRaw.post_activity + sonnetRaw.tg_message;
  const stdProposed = haikuRaw.daily_checkin + haikuRaw.post_activity + sonnetRaw.tg_message;
  const rows = [
    ['Tier', 'Proactive', 'Interactive', 'Est. billed $/day', 'vs Standard-today'],
    ['Saver', 'Haiku', 'Haiku', `$${billed(saver).toFixed(2)}`, pct(saver, stdToday)],
    [
      'Standard (proposed)',
      'Haiku',
      'Sonnet',
      `$${billed(stdProposed).toFixed(2)}`,
      pct(stdProposed, stdToday),
    ],
    ['Standard (today)', 'Sonnet', 'Sonnet', `$${billed(stdToday).toFixed(2)}`, '—'],
  ];
  const header = rows[0]!;
  const head = `| ${header.join(' | ')} |`;
  const sep = `| ${header.map(() => '---').join(' | ')} |`;
  const body = rows.slice(1).map((r) => `| ${r.join(' | ')} |`).join('\n');
  return (
    `**Implied tier burn** (scales the §2 $0.53 raw/day Sonnet baseline, split 38/19/41, by this run's measured Haiku/Sonnet ratios; ×1.5 → billed):\n\n` +
    `${head}\n${sep}\n${body}\n\n` +
    `_Premium (Sonnet/Opus) is out of scope — this A/B is Haiku vs Sonnet, the question being whether Standard's proactive slot can be Haiku._`
  );
}

function pct(a: number, b: number): string {
  if (b <= 0) return '—';
  const d = (a - b) / b;
  const sign = d >= 0 ? '+' : '−';
  return `${sign}${Math.abs(Math.round(d * 100))}%`;
}

function renderReport(
  pairs: Pair[],
  models: string[],
  meta: { generatedAt: string; sample: string[]; totalCost: number; runCount: number; errors: number },
): string {
  const out: string[] = [];
  out.push(`# Model A/B eval — Haiku 4.5 vs Sonnet 4.6`);
  out.push('');
  out.push(`_Generated ${meta.generatedAt} · ${META_SOURCE}_`);
  out.push('');
  out.push(`- **Sample:** ${meta.sample.join(', ')}`);
  out.push(`- **Models:** ${models.map(modelShort).join(' vs ')} (\`${models.join('`, `')}\`)`);
  out.push(`- **Runs:** ${meta.runCount} (${meta.errors} errored)`);
  out.push(`- **Total raw API spend:** $${meta.totalCost.toFixed(4)}`);
  out.push('');
  out.push(`Read-only dry run: no Telegram sends, no \`agent_runs\` rows, no credit draw-down, no memory/plan writes. Each pair below ran both models against byte-identical copies of the same hydrated folder with the same prompt — only the model differs.`);
  out.push('');

  out.push(`## Cost summary`);
  out.push('');
  out.push(categoryCostSummary(pairs, models));
  out.push('');

  for (const cat of ['daily_checkin', 'post_activity', 'tg_message']) {
    const inCat = pairs.filter((p) => p.category === cat);
    if (inCat.length === 0) continue;
    out.push(`## ${CATEGORY_TITLES[cat]}`);
    out.push('');
    for (const pair of inCat) {
      out.push(`### ${pair.athlete} — ${pair.inputLabel}`);
      out.push('');
      if (pair.inputText) {
        out.push(`**Input:** ${pair.inputText.replace(/\n/g, ' ')}`);
        out.push('');
      } else if (cat === 'post_activity') {
        out.push(`**Input:** post-activity note on the athlete's most-recent ${pair.inputLabel} (Strava).`);
        out.push('');
      }
      out.push(metricsTable(pair, models));
      out.push('');
      for (const m of models) {
        const r = pair.results[m];
        out.push(`**${modelShort(m)}**${r?.error ? ` — error: ${r.error}` : ''}`);
        out.push('');
        out.push(quote(r?.replyText ?? ''));
        out.push('');
      }
      out.push('---');
      out.push('');
    }
  }

  out.push(`## Judge (deferred)`);
  out.push('');
  out.push(
    `A blind Opus judge pass (factual-accuracy auto-fail + voice/quality score per CLAUDE.md §3) is an additive \`--judge\` second pass, intentionally not built yet — the human side-by-side above is the voice gate. It would score each pair with model identity hidden and emit a scorecard alongside this report.`,
  );
  out.push('');
  return out.join('\n');
}

const META_SOURCE = 'Specs/METERING_PAYMENTS.md §14 · Specs/EVAL_HARNESS.md Phase 0';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { hydrateSnapshot, runSnapshot, releaseSnapshot } = await import('../worker/dry-run-agent');

  let athletes = args.athleteEmails.length
    ? await resolveAthletes(args.athleteEmails)
    : DEFAULT_ATHLETES;
  if (args.quick) athletes = athletes.slice(0, 1);
  if (athletes.length === 0) {
    console.error('No athletes resolved. Aborting.');
    process.exit(1);
  }

  const models = args.models;
  const realCount = args.quick ? 1 : args.realCount;
  const curated = args.quick ? CURATED_QUESTIONS.slice(0, 1) : CURATED_QUESTIONS;

  console.log(`Sample: ${athletes.map((a) => a.name).join(', ')}`);
  console.log(`Models: ${models.join(', ')}`);
  console.log(
    args.proactiveOnly
      ? `Categories: daily + post-activity only (--proactive-only)`
      : `Interactive: ${realCount} real + ${curated.length} curated per athlete`,
  );
  console.log(`ATHLETE_ROOT=${process.env.ATHLETE_ROOT}\n`);

  const pairs: Pair[] = [];
  let totalCost = 0;
  let runCount = 0;
  let errors = 0;

  // One A/B unit: hydrate once, run every model against identical copies.
  async function abUnit(
    athlete: { name: string; id: string },
    source: 'daily_checkin' | 'post_activity' | 'tg_message',
    inputLabel: string,
    opts: { message?: string; activityId?: number } = {},
  ): Promise<void> {
    let snapshot;
    try {
      snapshot = await hydrateSnapshot(athlete.id, source, opts);
    } catch (e) {
      console.error(`  ✗ hydrate failed (${athlete.name}/${source}/${inputLabel}):`, e);
      return;
    }
    if (source === 'post_activity' && snapshot.activityId == null) {
      console.log(`  · skip post_activity for ${athlete.name} — no recent Strava activity`);
      await releaseSnapshot(snapshot);
      return;
    }
    const resolvedLabel =
      source === 'post_activity' ? `activity ${snapshot.activityId}` : inputLabel;
    const pair: Pair = {
      athlete: athlete.name,
      category: source,
      inputLabel: resolvedLabel,
      inputText: opts.message,
      results: {},
    };
    for (const model of models) {
      process.stdout.write(`  → ${athlete.name} / ${source} / ${resolvedLabel} / ${modelShort(model)} … `);
      try {
        const r = await runSnapshot(snapshot, model);
        pair.results[model] = r;
        runCount += 1;
        if (r.costUsd) totalCost += r.costUsd;
        if (r.error) errors += 1;
        console.log(
          r.error
            ? `ERROR (${r.error.slice(0, 60)})`
            : `${money(r.costUsd)} · ${intOr(r.numTurns)} turns · run total $${totalCost.toFixed(3)}`,
        );
      } catch (e) {
        console.log(`THREW (${e instanceof Error ? e.message : String(e)})`);
        errors += 1;
      }
    }
    await releaseSnapshot(snapshot);
    pairs.push(pair);
  }

  for (const athlete of athletes) {
    console.log(`\n=== ${athlete.name} ===`);
    // 1. Daily check-in
    await abUnit(athlete, 'daily_checkin', 'morning check-in');
    // 2. Post-activity (most-recent real activity)
    await abUnit(athlete, 'post_activity', 'most-recent activity');
    // 3. Interactive — real recent inbound + curated canonical (skipped in
    //    --proactive-only: §14's gate is about the proactive runs).
    if (!args.proactiveOnly) {
      if (!args.quick) {
        const real = await realInboundQuestions(athlete.id, realCount);
        for (const q of real) await abUnit(athlete, 'tg_message', q.tag, { message: q.text });
      }
      for (const q of curated) {
        await abUnit(athlete, 'tg_message', `curated: ${q.tag}`, { message: q.text });
      }
    }
  }

  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, '-').slice(0, 16);
  const report = renderReport(pairs, models, {
    generatedAt,
    sample: athletes.map((a) => a.name),
    totalCost,
    runCount,
    errors,
  });
  const outPath = path.join(process.cwd(), `ab-model-eval-${stamp}.md`);
  writeFileSync(outPath, report, 'utf8');

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Runs: ${runCount} (${errors} errored)`);
  console.log(`Total raw API spend: $${totalCost.toFixed(4)}`);
  console.log(`Report: ${outPath}`);
}

function cleanupRoot(): void {
  try {
    rmSync(process.env.ATHLETE_ROOT!, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

main()
  .then(() => {
    cleanupRoot();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    cleanupRoot();
    process.exit(1);
  });
