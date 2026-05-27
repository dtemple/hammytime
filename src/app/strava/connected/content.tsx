'use client';

import { useSearchParams } from 'next/navigation';

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
            Activity access wasn&rsquo;t granted. The coaching agent needs permission to read your
            activities — that&rsquo;s the &ldquo;View data about your activities&rdquo; checkbox on
            the Strava consent screen.
          </p>
          <p style={{ color: '#666' }}>
            Return to Telegram and run <strong>/connect_strava</strong> again. On the Strava screen,
            make sure &ldquo;View data about your activities&rdquo; is checked before clicking
            Authorize.
          </p>
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
      </div>
    </main>
  );
}
