import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { sign } from '@/lib/state-sign';
import { getAuthorizeUrl } from '@/server/strava/client';

export async function GET(req: NextRequest) {
  const athleteId = req.nextUrl.searchParams.get('athlete_id');
  if (!athleteId) {
    return NextResponse.json({ error: 'athlete_id is required' }, { status: 400 });
  }

  const state = sign({
    athlete_id: athleteId,
    iat: Date.now(),
    nonce: randomBytes(8).toString('hex'),
  });

  return NextResponse.redirect(getAuthorizeUrl(state));
}
