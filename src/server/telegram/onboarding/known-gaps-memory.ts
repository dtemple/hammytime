// W5 (onboarding v2): seed the per-athlete known-gaps tracker the daily coach
// fills opportunistically. Onboarding keeps the structured interview short and
// leaves the nice-to-haves (age, target time, tune-up races, strength
// equipment, schedule constraints, recent long run) for the coach to ask about
// at the moment the answer changes a prescription — see Specs/ONBOARDING_V2.md
// (W5) and src/lib/known-gaps.ts for the catalog.
//
// This module writes the initial `known_gaps.md` memory file at onboarding
// completion. The coach reads and edits it each run (worker/prompts/coach.md,
// "Filling known gaps"); syncBack persists those edits like any other memory
// file, so no DB table or migration is involved.

import { supabaseAdmin } from '@/lib/db';
import { KNOWN_GAPS, type KnownGapKey } from '@/lib/known-gaps';
import { raceOnlyGapKeys } from './slots/schema';
import { formatFinishTime } from './parsing/durations';
import type { Extracted } from './steps/05-enrichment';

export const KNOWN_GAPS_FILE = 'known_gaps.md';

// Listing order: the gaps the coach reaches for most come first.
const GAP_ORDER: KnownGapKey[] = [
  'strength_equipment',
  'target_time',
  'tune_up_races',
  'schedule_constraints',
  'age',
  'recent_long_run',
];

// Gaps onboarding already captured, marked filled in the seed so the coach
// doesn't re-ask. Stated only — inferred and unknown stay open for the coach to
// confirm, mirroring the stated-only backfill in 05-enrichment.ts onComplete.
function filledFromEnrichment(e: Extracted | null): Partial<Record<KnownGapKey, string>> {
  const filled: Partial<Record<KnownGapKey, string>> = {};
  if (!e) return filled;

  if (e.age.provenance === 'stated' && typeof e.age.value === 'number') {
    filled.age = String(e.age.value);
  }
  if (e.target_time_sec.provenance === 'stated' && typeof e.target_time_sec.value === 'number') {
    filled.target_time = formatFinishTime(e.target_time_sec.value);
  }
  const statedTuneups = e.tuneup_races.filter((t) => t.provenance === 'stated');
  if (statedTuneups.length > 0) {
    filled.tune_up_races = statedTuneups
      .map((t) => (t.date ? `${t.name} (${t.date})` : t.name))
      .join('; ');
  }
  if (
    e.schedule_notes.provenance === 'stated' &&
    typeof e.schedule_notes.value === 'string' &&
    e.schedule_notes.value.trim()
  ) {
    filled.schedule_constraints = e.schedule_notes.value.trim();
  }
  return filled;
}

const HEADER = [
  '# Known gaps',
  '',
  'Facts onboarding left for the coach to fill later. Ask about ONE only when it',
  "changes today's prescription. Not a questionnaire. When the athlete answers,",
  'rewrite that line to `[filled YYYY-MM-DD] <key>: <value>` and stop asking.',
  '',
].join('\n');

export interface ParsedGaps {
  /** Open gap keys, in file order (which is GAP_ORDER). */
  open: KnownGapKey[];
  /** Already-filled gaps and their values. */
  filled: Partial<Record<KnownGapKey, string>>;
}

const VALID_GAP_KEYS = new Set<string>(Object.keys(KNOWN_GAPS));

/** Parse a `known_gaps.md` body back into its open keys and filled values — the
 *  inverse of `renderKnownGapsFromFilled`. The /edit_profile "Finish my profile"
 *  walk (onboarding v3 W3) uses `open` to build its ask-queue and `filled` to
 *  preserve already-answered gaps when it re-renders the file. Tolerant of
 *  whitespace; ignores lines that aren't gap entries. */
export function parseKnownGaps(md: string): ParsedGaps {
  const open: KnownGapKey[] = [];
  const filled: Partial<Record<KnownGapKey, string>> = {};
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    const openKey = line.match(/^- \[open\]\s+([a-z_]+):/)?.[1];
    if (openKey && VALID_GAP_KEYS.has(openKey)) {
      open.push(openKey as KnownGapKey);
      continue;
    }
    const filledM = line.match(/^- \[filled[^\]]*\]\s+([a-z_]+):\s*(.*)$/);
    const filledKey = filledM?.[1];
    if (filledKey && VALID_GAP_KEYS.has(filledKey)) {
      filled[filledKey as KnownGapKey] = (filledM?.[2] ?? '').trim();
    }
  }
  return { open, filled };
}

/** Options for the gap renderer/seeder. */
export interface SeedGapsOptions {
  /** Drop the race-only gaps (`target_time`, `tune_up_races`) entirely — used for a
   *  no-race / keep_fit athlete so the coach never sees or asks them (V3-W7). The
   *  set comes from the slot schema's `raceOnly` flag. */
  excludeRaceOnly?: boolean;
}

/** Pure renderer from a pre-computed filled-gap map. The v3 engine builds the map
 *  with `slotsToGaps` (slots/schema.ts); v2 builds it from enrichment. */
export function renderKnownGapsFromFilled(
  filled: Partial<Record<KnownGapKey, string>>,
  today: string,
  options: SeedGapsOptions = {},
): string {
  const excluded = options.excludeRaceOnly ? raceOnlyGapKeys() : null;
  const lines = GAP_ORDER.filter((key) => !excluded?.has(key)).map((key) => {
    const def = KNOWN_GAPS[key];
    const value = filled[key];
    if (value != null) {
      return `- [filled ${today}] ${key}: ${value}`;
    }
    const opts = def.options ? ` (${def.options.join(' / ')})` : '';
    return `- [open] ${key}: ${def.what} Ask when: ${def.paysOffWhen}${opts}`;
  });
  return `${HEADER}${lines.join('\n')}\n`;
}

/** Pure renderer: builds the `known_gaps.md` body from the catalog + whatever
 *  onboarding already captured. `today` is the ISO date stamped on filled gaps. */
export function renderKnownGaps(e: Extracted | null, today: string): string {
  return renderKnownGapsFromFilled(filledFromEnrichment(e), today);
}

/** Writes the initial known_gaps.md memory file from a pre-computed filled-gap
 *  map. Idempotent on (athlete_id, file_name). */
export async function seedKnownGapsFromFilled(
  athleteId: string,
  filled: Partial<Record<KnownGapKey, string>>,
  options: SeedGapsOptions = {},
): Promise<void> {
  const now = new Date();
  const content = renderKnownGapsFromFilled(filled, now.toISOString().slice(0, 10), options);

  const { error } = await supabaseAdmin().from('memory_files').upsert(
    {
      athlete_id: athleteId,
      file_name: KNOWN_GAPS_FILE,
      content_md: content,
      updated_at: now.toISOString(),
    },
    { onConflict: 'athlete_id,file_name' },
  );
  if (error) throw new Error(`seedKnownGaps failed: ${error.message}`);
}

/** Writes the initial known_gaps.md memory file for an athlete who just finished
 *  onboarding. Idempotent on (athlete_id, file_name). */
export async function seedKnownGaps(athleteId: string, e: Extracted | null): Promise<void> {
  await seedKnownGapsFromFilled(athleteId, filledFromEnrichment(e));
}

/** Read an athlete's known_gaps.md body, or '' if there isn't one yet. Used by
 *  the /edit_profile "Finish my profile" walk (onboarding v3 W3) to find the
 *  open gaps. */
export async function loadKnownGapsContent(athleteId: string): Promise<string> {
  const { data } = await supabaseAdmin()
    .from('memory_files')
    .select('content_md')
    .eq('athlete_id', athleteId)
    .eq('file_name', KNOWN_GAPS_FILE)
    .maybeSingle();
  return data?.content_md ?? '';
}
