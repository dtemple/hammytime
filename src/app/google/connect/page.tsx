import { randomBytes } from 'crypto';
import { sign } from '@/lib/state-sign';
import { getAuthorizeUrl } from '@/server/google/client';
import { SiteShell } from '@/components/SiteShell';

export default async function GoogleConnectPage({
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
          Head back to Telegram and run <span className="sg-em">/calendar</span> to get a fresh
          link.
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
      <div className="sg-eyebrow">Connect Google Calendar</div>
      <h1 className="sg-title">
        Put your plan on your <span className="sg-accent">calendar</span>.
      </h1>
      <p className="sg-lede">
        Daybreak creates its own calendar in your Google account and keeps your workouts on it —
        changes show up within seconds. It can&apos;t see or touch your other calendars, and you
        can disconnect anytime.
      </p>
      <a href={authorizeUrl} className="sg-btn sg-btn-primary">
        Connect Google Calendar
      </a>
      <p className="sg-hint">
        Google will ask you to allow &ldquo;create and manage its own calendars&rdquo; — that one
        permission is all Daybreak gets.
      </p>
    </SiteShell>
  );
}
