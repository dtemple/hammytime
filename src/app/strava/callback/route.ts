import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { verify } from "@/lib/state-sign";
import { exchangeCode } from "@/server/strava/client";
import { encryptToken } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/db";
import { sendAndLog } from "@/server/telegram/bot";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const stateToken = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.json(
      { error: `Strava OAuth error: ${error}` },
      { status: 400 }
    );
  }
  if (!code || !stateToken) {
    return NextResponse.json(
      { error: "Missing code or state" },
      { status: 400 }
    );
  }

  // Strava lets users deselect individual permissions during the consent flow.
  // Reject the connection if activity:read_all wasn't granted — a token without
  // it returns an empty activity list and we'd silently coach with no data.
  const scope = searchParams.get("scope") ?? "";
  if (!scope.includes("activity:read_all")) {
    return NextResponse.redirect(
      new URL("/strava/connected?error=insufficient_scope", req.nextUrl.origin)
    );
  }

  let athleteId: string;
  try {
    const payload = verify(stateToken);
    athleteId = payload.athlete_id;
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid state: ${String(err)}` },
      { status: 400 }
    );
  }

  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode(code);
  } catch (err) {
    return NextResponse.json(
      { error: `Token exchange failed: ${String(err)}` },
      { status: 502 }
    );
  }

  const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
    encryptToken(tokens.access_token),
    encryptToken(tokens.refresh_token),
  ]);

  const db = supabaseAdmin();
  const { error: upsertErr } = await db.from("oauth_tokens").upsert(
    {
      athlete_id: athleteId,
      provider: "strava",
      access_token_enc: accessTokenEnc,
      refresh_token_enc: refreshTokenEnc,
      expires_at: new Date(tokens.expires_at * 1000).toISOString(),
      provider_athlete_id: tokens.provider_athlete_id,
    },
    { onConflict: "athlete_id,provider" }
  );

  if (upsertErr) {
    return NextResponse.json(
      { error: `DB upsert failed: ${upsertErr.message}` },
      { status: 500 }
    );
  }

  // Telegram confirmation — best-effort, never fails the callback.
  try {
    const { data: confirmedAthlete } = await db
      .from("athletes")
      .select("id, telegram_chat_id")
      .eq("id", athleteId)
      .maybeSingle();

    if (confirmedAthlete?.telegram_chat_id) {
      await sendAndLog(
        confirmedAthlete.id,
        confirmedAthlete.telegram_chat_id,
        "Strava connected. I can now read your training when you /checkin."
      );
    }
  } catch (err) {
    Sentry.captureException(err);
    // Continue — browser still gets the connected page.
  }

  const redirectUrl = new URL("/strava/connected", req.nextUrl.origin);
  return NextResponse.redirect(redirectUrl);
}
