import { randomBytes } from 'crypto';
import { sign } from '@/lib/state-sign';
import { getAuthorizeUrl } from '@/server/strava/client';

export default async function StravaConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ athlete_id?: string }>;
}) {
  const { athlete_id: athleteId } = await searchParams;

  if (!athleteId) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-white px-4">
        <div className="w-full max-w-sm text-center">
          <p className="text-sm text-zinc-800 mb-2">This link is missing its athlete ID.</p>
          <p className="text-sm text-zinc-500">
            Head back to Telegram and run <span className="font-medium">/connect_strava</span> to
            get a fresh link.
          </p>
        </div>
      </main>
    );
  }

  // Server Component runs once per request. The 10-minute state TTL
  // (see src/lib/state-sign.ts) starts here, when the page renders.
  // eslint-disable-next-line react-hooks/purity
  const state = sign({ athlete_id: athleteId, iat: Date.now(), nonce: randomBytes(8).toString('hex') });
  const authorizeUrl = getAuthorizeUrl(state);

  return (
    <main className="min-h-screen flex items-center justify-center bg-white px-4">
      <div className="w-full max-w-sm text-center">
        <p className="text-sm text-zinc-500 mb-6">
          Connect your Strava account so your running partner can read your recent training and tailor each
          day&apos;s advice.
        </p>
        <a href={authorizeUrl} className="inline-block">
          {/* Official Strava asset — do not modify, recolor, or resize below 48px height. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/strava/btn_strava_connect_with_orange.svg"
            alt="Connect with Strava"
            width={237}
            height={48}
          />
        </a>
        <p className="text-xs text-zinc-400 mt-6">
          You&apos;ll be asked to allow access to your activities. Check that box — Daybreak needs
          it to see your runs.
        </p>
      </div>
    </main>
  );
}
