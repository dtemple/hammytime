import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import ContactEmail from '@/components/ContactEmail';

export const metadata: Metadata = {
  title: 'Privacy — Daybreak',
  description: 'What Daybreak collects, how it uses it, and your choices.',
};

export default function Privacy() {
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
        <h1 className="ht-h1">Privacy Policy</h1>
        <p className="ht-updated">Last updated: May 29, 2026</p>

        <div className="ht-legal">
          <section>
            <h2>Introduction</h2>
            <p>
              Daybreak is a running partner you use over Telegram. This policy explains what it
              collects, how it uses that, and the choices you have.
            </p>
          </section>

          <section>
            <h2>Information we collect</h2>
            <ul>
              <li>Your Telegram identity — the chat ID and name Telegram shares with the bot.</li>
              <li>Your Strava activity data, read-only, so Daybreak has something to stand on.</li>
              <li>The training plan and onboarding answers you provide.</li>
              <li>The messages you send the bot.</li>
              <li>Your check-in responses — how ready and how sore you&apos;re feeling.</li>
              <li>Basic usage data needed to run the service.</li>
            </ul>
          </section>

          <section>
            <h2>How we use it</h2>
            <p>
              We use this information to run Daybreak, generate your daily
              guidance, deliver it to you over Telegram, keep the service working, and meter
              billing once you&apos;re on pay-as-you-go.
            </p>
          </section>

          <section>
            <h2>Third-party services</h2>
            <p>Daybreak relies on a few services to operate:</p>
            <ul>
              <li>Telegram — to message you.</li>
              <li>Strava — for your activity data.</li>
              <li>Anthropic (Claude) — to generate your guidance.</li>
              <li>Supabase — database and storage.</li>
              <li>Vercel — web hosting.</li>
              <li>Fly.io — background compute that runs Daybreak.</li>
            </ul>
          </section>

          <section>
            <h2>Data retention</h2>
            <p>
              We keep your data while your account is active. Ask us to delete it and we will.
            </p>
          </section>

          <section>
            <h2>Data security</h2>
            <p>
              Your Strava tokens and any API keys are encrypted at rest, and access to your
              data is restricted.
            </p>
          </section>

          <section>
            <h2>Your rights</h2>
            <p>
              You can ask to see the data we hold, correct it, or have it deleted. You can
              disconnect Strava anytime with <code>/disconnect_strava</code> or by revoking
              access from Strava directly.
            </p>
          </section>

          <section>
            <h2>Changes to this policy</h2>
            <p>
              We may update this policy as Daybreak changes. If we make a meaningful change,
              we&apos;ll let you know over Telegram or email.
            </p>
          </section>

          <section>
            <h2>Contact</h2>
            <p>Questions about your privacy? Get in touch.</p>
            <ContactEmail />
          </section>
        </div>
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
