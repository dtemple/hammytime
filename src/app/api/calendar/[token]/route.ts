import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { renderPlanIcs } from '@/lib/calendar-render';
import { PlanSchema } from '@/lib/plan-schema';

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

  const { data: athlete } = await db
    .from('athletes')
    .select('name, timezone')
    .eq('id', link.athlete_id)
    .maybeSingle();

  if (!athlete) return notFound();

  const { data: plan } = await db
    .from('plans')
    .select('id, start_date, current_version_id')
    .eq('athlete_id', link.athlete_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let parsedPlan = null;
  let planId: string | null = null;
  let planStartDate: string | null = null;

  if (plan?.current_version_id) {
    const { data: version } = await db
      .from('plan_versions')
      .select('id, plan_json')
      .eq('id', plan.current_version_id)
      .maybeSingle();

    if (version?.plan_json) {
      const result = PlanSchema.safeParse(version.plan_json);
      if (result.success) {
        parsedPlan = result.data;
        planId = plan.id;
        planStartDate = plan.start_date;
      }
    }
  }

  const ics = renderPlanIcs({
    athleteName: athlete.name,
    timezone: athlete.timezone,
    plan: parsedPlan,
    planId,
    planStartDate,
  });

  return new NextResponse(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="training.ics"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
