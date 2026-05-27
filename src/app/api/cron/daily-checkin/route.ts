import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { supabaseAdmin } from "@/lib/db";
import { sendAndLog } from "@/server/telegram/bot";
import {
  writeCheckinState,
  nowInTimezone,
} from "@/server/telegram/checkin/dispatcher";
import { READINESS_PROMPT } from "@/server/telegram/checkin/wellness";
import { wellnessLogContains } from "@/server/telegram/checkin/wellness-log";
import { onboardingSteps } from "@/server/telegram/onboarding";

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const { data: athletes, error } = await supabaseAdmin()
      .from("athletes")
      .select("*")
      .not("telegram_chat_id", "is", null);
    if (error) throw new Error(`athletes query failed: ${error.message}`);

    const onboarded = (athletes ?? []).filter((a) => {
      const step = (a.onboarding_state as { step?: number } | null)?.step ?? 0;
      return step >= onboardingSteps.length;
    });

    if (onboarded.length === 0) {
      return NextResponse.json({ ok: true, skipped: "no_onboarded_athlete" });
    }
    if (onboarded.length > 1) {
      console.warn(
        `[daily-checkin cron] multiple onboarded athletes (${onboarded.length}); picking first`
      );
    }

    const athlete = onboarded[0];

    const cs = athlete.checkin_state as { sub_step?: string } | null;
    if (cs?.sub_step) {
      return NextResponse.json({ ok: true, skipped: "mid_checkin" });
    }

    const { date } = nowInTimezone(athlete.timezone);
    if (await wellnessLogContains(athlete.id, date)) {
      return NextResponse.json({ ok: true, skipped: "already_checked_in_today" });
    }

    await writeCheckinState(athlete.id, {
      sub_step: "awaiting_readiness",
      partial: {},
    });
    await sendAndLog(athlete.id, athlete.telegram_chat_id!, READINESS_PROMPT);

    return NextResponse.json({ ok: true, fired: athlete.id });
  } catch (err) {
    Sentry.captureException(err);
    console.error("[daily-checkin cron] error", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
