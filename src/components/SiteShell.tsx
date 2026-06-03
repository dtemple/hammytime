import Image from 'next/image';
import Link from 'next/link';

/**
 * Shared page chrome for the signup + Strava flows.
 *
 * Reuses the landing page's `.ht-*` header/footer styling (see globals.css) so
 * there's one source of truth for the brand chrome. The centered card layout
 * (`.sg-main` / `.sg-card`) and the content classes live alongside it.
 *
 * `nav` and `footer` default on (the signup flow). The Strava pages are reached
 * mid-flow from inside Telegram, so they pass `nav={false} footer={false}` for a
 * bare logo + card.
 *
 * Only uses Link/Image (no hooks), so it works inside both server and client
 * components.
 */
export function SiteShell({
  children,
  nav = true,
  footer = true,
}: {
  children: React.ReactNode;
  nav?: boolean;
  footer?: boolean;
}) {
  return (
    <div className="ht-page">
      <header className="ht-header">
        <Link href="/" className="ht-brand">
          <Image
            src="/daybreak-icon.png"
            alt=""
            width={22}
            height={22}
            className="ht-brand-icon"
            aria-hidden="true"
          />
          Daybreak
        </Link>
        {nav && (
          <nav className="ht-nav">
            <Link href="/login">Log in</Link>
          </nav>
        )}
      </header>

      <main className="sg-main">
        <div className="sg-card">{children}</div>
      </main>

      {footer && (
        <footer className="ht-footer">
          <span>© 2026 Daybreak</span>
          <span className="ht-footer-links">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/support">Support</Link>
          </span>
        </footer>
      )}
    </div>
  );
}
