'use client';

import { useSearchParams } from 'next/navigation';
import { SiteShell } from '@/components/SiteShell';

// Official "Powered by Strava" mark. Required wherever Strava data is surfaced.
// Do not modify or recolor the asset, and keep it less prominent than the app's own name.
function PoweredByStrava() {
  return (
    <div className="sg-strava-mark">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/strava/api_logo_pwrdBy_strava_horiz_black.svg"
        alt="Powered by Strava"
        width={237}
        height={24}
      />
    </div>
  );
}

const Check = () => (
  <svg
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2.5 7.5l3 3 6-7" />
  </svg>
);

export function StravaConnectedContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');

  if (error === 'insufficient_scope') {
    return (
      <SiteShell nav={false} footer={false}>
        <div className="sg-badge sg-badge-info">Connection incomplete</div>
        <h1 className="sg-title">Almost there.</h1>
        <p className="sg-lede">
          Activity access wasn&rsquo;t granted. Daybreak needs permission to read your activities —
          that&rsquo;s the &ldquo;View data about your activities&rdquo; checkbox on the Strava
          consent screen.
        </p>
        <p className="sg-lede">
          Return to Telegram and run <span className="sg-em">/connect_strava</span>{' '}
          again. On the Strava screen, make sure &ldquo;View data about your activities&rdquo; is
          checked before clicking Authorize.
        </p>
        <PoweredByStrava />
      </SiteShell>
    );
  }

  return (
    <SiteShell nav={false} footer={false}>
      <div className="sg-badge sg-badge-ok">
        <Check /> Strava connected
      </div>
      <h1 className="sg-title">You&apos;re connected.</h1>
      <p className="sg-lede">Return to Telegram to continue.</p>
      <PoweredByStrava />
    </SiteShell>
  );
}
