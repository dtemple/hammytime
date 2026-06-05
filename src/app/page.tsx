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
            <span className="ht-h1-accent">Your schedule. Your body. Your goals. </span>Daybreak makes it work.
          </h1>
          <p className="ht-lede">
            Daybreak is a daily running companion that helps you avoid injuries and achieve your goals. It uses your Strava data, your injury history and your training goals to create a personalized training calendar that updates to your needs. Simply tell it what you want.
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

        <section id="how" className="ht-does">
          <div className="ht-does-label">What it does</div>
          <dl className="ht-does-list">
            <div className="ht-does-row">
              <dt>plan</dt>
              <dd>
                Creates a plan that fits your schedule and goals.
              </dd>
            </div>
            <div className="ht-does-row">
              <dt>load</dt>
              <dd>
                Tracks vertical, mileage and intensity from Strava. Pre-emptively flags risks.
              </dd>
            </div>
            <div className="ht-does-row">
              <dt>injury</dt>
              <dd>Remembers the calf, the IT band, the rolled ankle — and plans around them.</dd>
            </div>
            <div className="ht-does-row">
              <dt>calendar</dt>
              <dd>Writes the day&rsquo;s session into Google / Apple Calendar automatically.</dd>
            </div>
            <div className="ht-does-row">
              <dt>adjusts</dt>
              <dd>
                A morning message in Telegram. Reply in plain English; the plan adapts to your needs.
              </dd>
            </div>
          </dl>
          <p className="ht-does-manifesto">
            No leaderboards. No ads. No premium tier. Free to start, then pay for just the LLM tokens you use.
          </p>
        </section>
      </main>

      <footer className="ht-footer">
        <span>© 2026 Daybreak</span>
        <span className="ht-footer-links">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/support">Support</Link>
        </span>
      </footer>
    </div>
  );
}
