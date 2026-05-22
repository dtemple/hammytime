import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db";
import { validatePlan } from "@/server/agent/plan-validator";
import { extractNotesValue } from "@/server/agent/byo-plan";
import { sendAndLog } from "@/server/telegram/bot";
import { sendDavidAlert } from "@/server/admin/alerts";
import type { Plan } from "@/lib/plan-schema";

export async function POST(req: NextRequest) {
  // 1. Parse body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).token !== "string" ||
    typeof (body as Record<string, unknown>).plan_json !== "string"
  ) {
    return NextResponse.json(
      { error: "invalid_body", detail: "Body must include token (string) and plan_json (string)" },
      { status: 400 }
    );
  }

  const { token, plan_json } = body as { token: string; plan_json: string };

  // 2. Token lookup
  const db = supabaseAdmin();
  const { data: linkToken } = await db
    .from("link_tokens")
    .select("id, athlete_id, plan_version_id")
    .eq("token", token)
    .eq("purpose", "plan_paste")
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (!linkToken || !linkToken.athlete_id || !linkToken.plan_version_id) {
    return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  }

  // 3. JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(plan_json);
  } catch (e) {
    return NextResponse.json(
      { error: "json_parse_error", detail: String(e) },
      { status: 400 }
    );
  }

  // 4. Load athlete for cold-start context
  const { data: athlete } = await db
    .from("athletes")
    .select("id, notes, telegram_chat_id, name")
    .eq("id", linkToken.athlete_id)
    .single();

  if (!athlete) {
    return NextResponse.json({ error: "athlete_not_found" }, { status: 400 });
  }

  const longestRecentMi = parseFloat(
    extractNotesValue(athlete.notes, "Longest recent run") || "0"
  );

  // 5. Validate
  const result = validatePlan(parsed, { longest_recent_mi: longestRecentMi });
  if (!result.ok) {
    return NextResponse.json({ errors: result.errors }, { status: 400 });
  }

  // 6. Look up the plan row via plan_versions
  const { data: planVersion } = await db
    .from("plan_versions")
    .select("id, plan_id")
    .eq("id", linkToken.plan_version_id)
    .single();

  if (!planVersion) {
    return NextResponse.json({ error: "plan_version_not_found" }, { status: 400 });
  }

  const plan = parsed as Plan;
  const totalWeeks = plan.meta.total_weeks;
  const startDate = plan.meta.start_date;
  const peakVolume = Math.max(...plan.weeks.map((w) => w.planned_volume_mi));

  // 7. Atomic commit via RPC
  const { error: rpcError } = await db.rpc("accept_plan_paste", {
    p_link_token_id: linkToken.id,
    p_plan_version_id: planVersion.id,
    p_plan_id: planVersion.plan_id,
    p_plan_json: parsed,
    p_total_weeks: totalWeeks,
    p_start_date: startDate,
  });

  if (rpcError) {
    console.error("[plans/paste] accept_plan_paste RPC failed", rpcError);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  // 8. Build summary
  const summary = `${totalWeeks}-week plan for ${plan.meta.goal_race.name} starting ${startDate}, peak ${peakVolume} mi/wk`;

  // 9. Athlete confirmation in Telegram
  if (athlete.telegram_chat_id) {
    await sendAndLog(
      athlete.id,
      athlete.telegram_chat_id,
      `Plan received and validated. ${summary}. Daily check-ins will start once the coaching loop ships.`
    );
  }

  // 10. David alert
  await sendDavidAlert(
    `Plan paste-back received for ${athlete.name}.\n${summary}`
  );

  return NextResponse.json({ ok: true, summary });
}
