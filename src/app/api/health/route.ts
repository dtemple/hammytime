import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db";

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

export async function GET() {
  const postgres = await checkPostgres();

  const anthropic: ExternalCheck = { ok: false, configured: false };
  const telegram: ExternalCheck = { ok: false, configured: false };
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
