import { SiteShell } from '@/components/SiteShell';

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

export default async function GoogleConnectedPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  if (error === 'insufficient_scope') {
    return (
      <SiteShell nav={false} footer={false}>
        <div className="sg-badge sg-badge-info">Connection incomplete</div>
        <h1 className="sg-title">Almost there.</h1>
        <p className="sg-lede">
          Calendar access wasn&rsquo;t granted. Daybreak needs the &ldquo;create and manage its own
          calendars&rdquo; permission — that&rsquo;s the one checkbox on the Google consent screen.
        </p>
        <p className="sg-lede">
          Return to Telegram, run <span className="sg-em">/calendar</span>, and tap the connect
          button again. Leave the checkbox checked this time.
        </p>
      </SiteShell>
    );
  }

  if (error) {
    return (
      <SiteShell nav={false} footer={false}>
        <div className="sg-badge sg-badge-info">Not connected</div>
        <h1 className="sg-title">That didn&rsquo;t go through.</h1>
        <p className="sg-lede">
          The Google connection wasn&rsquo;t completed. Return to Telegram, run{' '}
          <span className="sg-em">/calendar</span>, and try again — or use the subscribe link
          there instead, which works without connecting.
        </p>
      </SiteShell>
    );
  }

  return (
    <SiteShell nav={false} footer={false}>
      <div className="sg-badge sg-badge-ok">
        <Check /> Google Calendar connected
      </div>
      <h1 className="sg-title">You&apos;re connected.</h1>
      <p className="sg-lede">
        A &ldquo;Daybreak — training&rdquo; calendar is being filled with your plan right now.
        Return to Telegram to continue.
      </p>
    </SiteShell>
  );
}
