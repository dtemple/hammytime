import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import ContactEmail from '@/components/ContactEmail';

export const metadata: Metadata = {
  title: 'Support — Daybreak',
  description: 'Answers to common questions about Daybreak, and how to get in touch.',
};

export default function Support() {
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
        <nav className="ht-nav">
          <Link href="/login">Log in</Link>
        </nav>
      </header>

      <main className="ht-main">
        <h1 className="ht-h1">Support</h1>
        <p className="ht-lede">
          A few common questions about Daybreak. If yours isn&apos;t here, get in touch at
          the bottom.
        </p>

        <dl className="ht-faq">
          <dt>What is Daybreak?</dt>
          <dd>
            Daily running guidance over Telegram. Daybreak looks at your recent Strava
            runs, your training plan, and how you&apos;re feeling, then suggests what to do
            each day so you keep progressing without getting hurt.
          </dd>

          <dt>How do I get access?</dt>
          <dd>
            Daybreak is invite-only for now. If you&apos;ve been added to the list, start
            at the <Link href="/signup">sign-up page</Link>
            {' '}
            and follow the Telegram link to the bot. If you haven&apos;t been added yet,
            email below and ask.
          </dd>

          <dt>Why does Daybreak need my Strava account?</dt>
          <dd>
            Your advice is built on what you&apos;ve actually been running. Connecting
            Strava is how Daybreak sees your training. Without it, there&apos;s nothing for
            the coaching to stand on, so the connection is required.
          </dd>

          <dt>What Strava data does Daybreak use?</dt>
          <dd>
            Read access to your activities, so it can look at your recent runs. Daybreak
            never posts to Strava and never changes anything in your account.
          </dd>

          <dt>How do I disconnect Strava or stop?</dt>
          <dd>
            Send <code>/disconnect_strava</code> to the bot, or revoke access from Strava
            (Settings → My Apps → Daybreak → Revoke Access). Revoking on Strava&apos;s side
            disconnects you here too.
          </dd>

          <dt>How does the daily check-in work?</dt>
          <dd>
            Daybreak messages you on Telegram. Reply to ask questions or adjust your plan,
            and send <code>/checkin</code> to log how ready and how sore you&apos;re feeling
            that day.
          </dd>

          <dt>What does it cost?</dt>
          <dd>
            Free for the first group of friends. After that it moves to pay-as-you-go: you
            add credit up front and it&apos;s drawn down as you use Daybreak.
          </dd>
        </dl>

        <section className="ht-contact-section">
          <h2 className="ht-h2">Still have a question?</h2>
          <p className="ht-lede">Email me and I&apos;ll get back to you.</p>
          <ContactEmail />
        </section>
      </main>

      <footer className="ht-footer">
        <span>© 2026 Daybreak</span>
        <span className="ht-footer-links">
          <Link href="/about">About</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/support">Support</Link>
        </span>
      </footer>
    </div>
  );
}
