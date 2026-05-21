import type { Metadata } from 'next';
import Link from 'next/link';
import CheckinBubble from '@/components/CheckinBubble';

export const metadata: Metadata = {
  title: 'HammyTime',
  description: 'Marathon coaching, every morning in Telegram.',
};

export default function Home() {
  return (
    <div className="ht-page">
      <header className="ht-header">
        <Link href="/" className="ht-brand">
          <span className="ht-brand-dot" aria-hidden="true" />
          HammyTime
        </Link>
        <nav className="ht-nav">
          <Link href="/login">Log in</Link>
        </nav>
      </header>

      <main className="ht-main">
        <section className="ht-hero">
          <div className="ht-eyebrow">MARATHON COACHING · TELEGRAM · INVITE ONLY</div>
          <h1 className="ht-h1">
            Achieve your goals{' '}
            <span className="ht-h1-accent">without getting injured</span>.
          </h1>
          <p className="ht-lede">
            Training plans are helpful, but life and injuries get in the way. HammyTime reads your
            Strava, remembers your past injuries, and helps you adjust your plan each week to
            maximize your chance of success and minimize your chance of getting injured.
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
                HammyTime adjusts your plan as you go to account for flare&#8209;ups, tweaks, and past injuries.
              </p>
            </div>
          </div>
          <div className="ht-step">
            <div className="ht-step-num">02</div>
            <div>
              <h3>Adjusts to real life</h3>
              <p>
                Training plans assume perfectly-spaced rest days, intervals and long runs. But life doesn't always line up that way. HammyTime helps you work through adjustments so that you can stick to the plan while minimizing injury risks.
              </p>
            </div>
          </div>
          <div className="ht-step">
            <div className="ht-step-num">03</div>
            <div>
              <h3>Daily check&#8209;ins</h3>
              <p>
                Research shows that a self-reported check-in beats data like HRV for injury prevention&emdash;and it takes just two minutes a day.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="ht-footer">
        <span>© 2026 HammyTime</span>
        <span className="ht-footer-links">
          <Link href="/about">About</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </span>
      </footer>
    </div>
  );
}
