import { supabaseAdmin } from '@/lib/db';
import { PlanSchema, type Plan } from '@/lib/plan-schema';

export type CalendarRenderInput = {
  athleteName: string;
  timezone: string;
  plan: Plan | null;
  planId: string | null;
  planStartDate: string | null;
};

// Load the athlete + active plan exactly as the calendar surfaces consume it.
// Shared by the ICS feed route and the Google Calendar reconciler so both
// render from the same active version. A plan with no current_version_id (or
// schema-invalid JSON) yields plan: null — render an empty calendar, don't 404.
export async function loadCalendarRenderInput(
  athleteId: string,
): Promise<CalendarRenderInput | null> {
  const db = supabaseAdmin();

  const { data: athlete } = await db
    .from('athletes')
    .select('name, timezone')
    .eq('id', athleteId)
    .maybeSingle();

  if (!athlete) return null;

  const { data: plan } = await db
    .from('plans')
    .select('id, start_date, current_version_id')
    .eq('athlete_id', athleteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let parsedPlan: Plan | null = null;
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

  return {
    athleteName: athlete.name,
    timezone: athlete.timezone,
    plan: parsedPlan,
    planId,
    planStartDate,
  };
}
