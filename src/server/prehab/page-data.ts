// Data loader for the public prehab routine page (/prehab/[token]). Extracted
// from the page so the token → athlete → memory_files lookup is unit-testable.
// Token semantics mirror the calendar route (src/app/api/calendar/[token]/
// route.ts): purpose-scoped, unexpired, unknown → null (the page 404s).

import { supabaseAdmin } from '@/lib/db';

export type PrehabPageData = {
  athleteName: string;
  // null = the coach hasn't authored prehab_program.md yet (the page shows a
  // pending state, not an error).
  contentMd: string | null;
  updatedAt: string | null;
};

export async function loadPrehabPageData(token: string): Promise<PrehabPageData | null> {
  const db = supabaseAdmin();

  const { data: link, error: linkErr } = await db
    .from('link_tokens')
    .select('athlete_id, expires_at')
    .eq('token', token)
    .eq('purpose', 'prehab')
    .maybeSingle();

  if (linkErr || !link?.athlete_id) return null;
  if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) return null;

  const { data: athlete } = await db
    .from('athletes')
    .select('name')
    .eq('id', link.athlete_id)
    .maybeSingle();
  if (!athlete?.name) return null;

  const { data: file } = await db
    .from('memory_files')
    .select('content_md, updated_at')
    .eq('athlete_id', link.athlete_id)
    .eq('file_name', 'prehab_program.md')
    .maybeSingle();

  return {
    athleteName: athlete.name,
    contentMd: file?.content_md ?? null,
    updatedAt: file?.updated_at ?? null,
  };
}
