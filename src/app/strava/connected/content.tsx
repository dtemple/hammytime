'use client';

import { useSearchParams } from 'next/navigation';

// Official "Powered by Strava" mark. Required wherever Strava data is surfaced.
// Do not modify or recolor the asset, and keep it less prominent than the app's own name.
function PoweredByStrava() {
  return (
    <div style={{ marginTop: '2rem' }}>
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

export function StravaConnectedContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');

  if (error === 'insufficient_scope') {
    return (
      <main
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center',
          padding: '2rem',
        }}
      >
        <div>
          <p style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>
            Strava connection incomplete.
          </p>
          <p style={{ color: '#666', marginBottom: '1rem' }}>
            Activity access wasn&rsquo;t granted. Daybreak needs permission to read your
            activities — that&rsquo;s the &ldquo;View data about your activities&rdquo; checkbox on
            the Strava consent screen.
          </p>
          <p style={{ color: '#666' }}>
            Return to Telegram and run <strong>/connect_strava</strong> again. On the Strava screen,
            make sure &ldquo;View data about your activities&rdquo; is checked before clicking
            Authorize.
          </p>
          <PoweredByStrava />
        </div>
      </main>
    );
  }

  return (
    <main
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        fontFamily: 'system-ui, sans-serif',
        textAlign: 'center',
        padding: '2rem',
      }}
    >
      <div>
        <p style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Strava connected.</p>
        <p style={{ color: '#666' }}>Return to Telegram to continue.</p>
        <PoweredByStrava />
      </div>
    </main>
  );
}
