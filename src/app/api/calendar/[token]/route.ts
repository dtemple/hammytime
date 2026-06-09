import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { renderPlanIcs } from '@/lib/calendar-render';
import { loadCalendarRenderInput } from '@/server/plans/active-plan';

function notFound(): NextResponse {
  return new NextResponse('Not found', { status: 404 });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token: rawToken } = await params;
  const token = rawToken.endsWith('.ics') ? rawToken.slice(0, -4) : rawToken;

  const db = supabaseAdmin();

  const { data: link, error: linkErr } = await db
    .from('link_tokens')
    .select('athlete_id, expires_at, purpose')
    .eq('token', token)
    .eq('purpose', 'calendar')
    .maybeSingle();

  if (linkErr || !link || !link.athlete_id) return notFound();
  if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) return notFound();

  const renderInput = await loadCalendarRenderInput(link.athlete_id);
  if (!renderInput) return notFound();

  const ics = renderPlanIcs(renderInput);

  return new NextResponse(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="training.ics"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
