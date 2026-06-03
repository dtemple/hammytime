import { randomBytes } from 'crypto';
import { sign } from '@/lib/state-sign';
import { getAuthorizeUrl } from '@/server/strava/client';
import { SiteShell } from '@/components/SiteShell';

export default async function StravaConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ athlete_id?: string }>;
}) {
  const { athlete_id: athleteId } = await searchParams;

  if (!athleteId) {
    return (
      <SiteShell nav={false} footer={false}>
        <div className="sg-badge sg-badge-info">Missing link</div>
        <h1 className="sg-title">This link is missing its athlete ID.</h1>
        <p className="sg-lede">
          Head back to Telegram and run <span className="sg-em">/connect_strava</span>{' '}
          to get a fresh link.
        </p>
      </SiteShell>
    );
  }

  // Server Component runs once per request. The 10-minute state TTL
  // (see src/lib/state-sign.ts) starts here, when the page renders.
  // eslint-disable-next-line react-hooks/purity
  const state = sign({ athlete_id: athleteId, iat: Date.now(), nonce: randomBytes(8).toString('hex') });
  const authorizeUrl = getAuthorizeUrl(state);

  return (
    <SiteShell nav={false} footer={false}>
      <div className="sg-eyebrow">Connect Strava</div>
      <h1 className="sg-title">
        Hook up your <span className="sg-accent">Strava</span>.
      </h1>
      <p className="sg-lede">
        Daybreak reads your recent training from Strava to tailor each day&apos;s advice. Connect
        once — you can disconnect anytime.
      </p>
      <a href={authorizeUrl} className="sg-strava-link">
        {/* Official Strava asset — do not modify, recolor, or resize below 48px height. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/strava/btn_strava_connect_with_orange.svg"
          alt="Connect with Strava"
          width={237}
          height={48}
        />
      </a>
      <p className="sg-hint">
        You&apos;ll be asked to allow access to your activities. Check that box — Daybreak needs it
        to see your runs.
      </p>
    </SiteShell>
  );
}
