import { supabaseAdmin } from '@/lib/db';
import type { WellnessEntry } from './types';

const FILE_NAME = 'wellness_log.md';

function formatRow(entry: WellnessEntry): string {
  return `| ${entry.date} | ${entry.time} | ${entry.readiness} | ${entry.soreness} | ${entry.body_part} | ${entry.note} |`;
}

function buildNewDocument(firstRow: string): string {
  return [
    '# Wellness Log',
    '',
    'Daily wellness battery entries. Append-only — do not edit or delete rows.',
    '',
    '## Entries',
    '',
    '| date | time | readiness | soreness | body_part | note |',
    '|------|------|-----------|----------|-----------|------|',
    firstRow,
  ].join('\n');
}

/**
 * Appends a wellness battery row to wellness_log.md for the given athlete.
 *
 * On first call (file doesn't exist): creates the full document with the
 * canonical header, schema table, and the first row.
 *
 * On subsequent calls: appends a pipe-delimited row to the existing content.
 *
 * This is a raw read-modify-write — does NOT use upsertMemorySection, which
 * does section-replace and would overwrite prior rows.
 */
export async function appendWellnessRow(athleteId: string, entry: WellnessEntry): Promise<void> {
  const db = supabaseAdmin();
  const newRow = formatRow(entry);

  const { data } = await db
    .from('memory_files')
    .select('content_md')
    .eq('athlete_id', athleteId)
    .eq('file_name', FILE_NAME)
    .maybeSingle();

  const now = new Date().toISOString();

  if (!data) {
    // First entry — create the full document from scratch.
    const { error } = await db.from('memory_files').upsert(
      {
        athlete_id: athleteId,
        file_name: FILE_NAME,
        content_md: buildNewDocument(newRow),
        updated_at: now,
      },
      { onConflict: 'athlete_id,file_name' },
    );
    if (error) throw new Error(`appendWellnessRow(create) failed: ${error.message}`);
    return;
  }

  // File exists — append a new row.
  const updated = data.content_md + '\n' + newRow;
  const { error } = await db
    .from('memory_files')
    .update({ content_md: updated, updated_at: now })
    .eq('athlete_id', athleteId)
    .eq('file_name', FILE_NAME);

  if (error) throw new Error(`appendWellnessRow(append) failed: ${error.message}`);
}

/**
 * Returns true if wellness_log.md contains a row for the given athlete-local date.
 *
 * Currently unused: this was the idempotency guard for the proactive morning
 * wellness battery (don't re-prompt if the athlete already logged today). That
 * proactive trigger was removed — the battery is now /checkin-only. Kept for
 * when the proactive morning battery is reintroduced (see worker/jobs/daily-checkin.ts).
 */
export async function wellnessLogContains(athleteId: string, date: string): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from('memory_files')
    .select('content_md')
    .eq('athlete_id', athleteId)
    .eq('file_name', FILE_NAME)
    .maybeSingle();
  if (!data) return false;
  return data.content_md.includes(`| ${date} |`);
}
