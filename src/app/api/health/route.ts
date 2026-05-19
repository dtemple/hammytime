import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db";
import { pingAnthropic } from "@/lib/anthropic";
import { pingTelegram } from "@/server/telegram/bot";

type PostgresCheck = { ok: boolean; latency_ms: number; error?: string };
type ExternalCheck = {
  ok: boolean;
  configured: boolean;
  latency_ms?: number;
  error?: string;
};

async function checkPostgres(): Promise<PostgresCheck> {
  const start = Date.now();
  try {
    const { error } = await supabaseAdmin()
      .from("athletes")
      .select("id")
      .limit(1);
    const latency_ms = Date.now() - start;
    if (error) return { ok: false, latency_ms, error: error.message };
    return { ok: true, latency_ms };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - start, error: String(err) };
  }
}

async function checkAnthropic(): Promise<ExternalCheck> {
  const configured = !!process.env.ANTHROPIC_API_KEY;
  if (!configured) return { ok: false, configured };
  try {
    const { latency_ms } = await pingAnthropic();
    return { ok: true, configured, latency_ms };
  } catch (err) {
    return { ok: false, configured, error: String(err) };
  }
}

async function checkTelegram(): Promise<ExternalCheck> {
  const configured = !!process.env.TELEGRAM_BOT_TOKEN;
  if (!configured) return { ok: false, configured };
  try {
    const { latency_ms } = await pingTelegram();
    return { ok: true, configured, latency_ms };
  } catch (err) {
    return { ok: false, configured, error: String(err) };
  }
}

export async function GET() {
  const [postgres, anthropic, telegram] = await Promise.all([
    checkPostgres(),
    checkAnthropic(),
    checkTelegram(),
  ]);

  const strava: ExternalCheck = { ok: false, configured: false };

  const configuredFailing = [anthropic, telegram, strava].some(
    (c) => c.configured && !c.ok
  );

  let status: "ok" | "degraded" | "error";
  if (!postgres.ok) {
    status = "error";
  } else {
    status = configuredFailing ? "degraded" : "ok";
  }

  return NextResponse.json(
    {
      status,
      timestamp: new Date().toISOString(),
      checks: { postgres, anthropic, telegram, strava },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
