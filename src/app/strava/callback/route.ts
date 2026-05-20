import { NextRequest, NextResponse } from "next/server";
import { verify } from "@/lib/state-sign";
import { exchangeCode } from "@/server/strava/client";
import { encryptToken } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/db";

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

  const redirectUrl = new URL("/strava/connected", req.nextUrl.origin);
  return NextResponse.redirect(redirectUrl);
}
