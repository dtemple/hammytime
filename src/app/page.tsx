import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import CheckinBubble from '@/components/CheckinBubble';

export const metadata: Metadata = {
  title: 'Daybreak',
  description: "A dynamic training calendar, to make sure you don't get injured.",
};

export default function Home() {
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
        <section className="ht-hero">
          <div className="ht-eyebrow"></div>
          <h1 className="ht-h1">
            <span className="ht-h1-accent">Daily training advice</span>, to make sure you
            don&apos;t get injured.
          </h1>
          <p className="ht-lede">
            Daybreak uses your Strava data, your injury history and your training goals to give you personalized daily training advice.
          </p>
          <div className="ht-cta-row">
            <Link href="/signup" className="ht-btn ht-btn-primary">
              Get started <span className="ht-arrow">→</span>
            </Link>
            <Link href="#how" className="ht-btn ht-btn-ghost">
              What it does
            </Link>
          </div>
        </section>

        <CheckinBubble />

        <section id="how" className="ht-steps">
          <div className="ht-step">
            <div className="ht-step-num">01</div>
            <div>
              <h3>Prevent injuries</h3>
              <p>
                Daybreak adjusts your plan as you go to account for flare&#8209;ups, tweaks, and
                past injuries.
              </p>
            </div>
          </div>
          <div className="ht-step">
            <div className="ht-step-num">02</div>
            <div>
              <h3>Connected to your calendar</h3>
              <p>
                Adds training sessions directly to your Google/Apple calendars.
              </p>
            </div>
          </div>
          <div className="ht-step">
            <div className="ht-step-num">03</div>
            <div>
              <h3>Daily check&#8209;ins</h3>
              <p>
                Ask questions, make updates, and personalize it to your needs. Daybreak is grounded in real-life training principles, injury patterns and strength plans.
              </p>
            </div>
          </div>
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
