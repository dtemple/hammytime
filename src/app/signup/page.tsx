import { randomBytes } from 'crypto';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import QRCode from 'qrcode';
import { supabaseAdmin } from '@/lib/db';
import { sendDavidAlert } from '@/server/admin/alerts';
import { SiteShell } from '@/components/SiteShell';

/**
 * /signup — invite + waitlist flow.
 *
 * One email field, then branch on the allow-list (all states are one server
 * component driven by searchParams — no client components):
 *   (no params)               → email entry              ("Check my invite")
 *   ?email=…    + on list      → success (Telegram deeplink + QR)
 *   ?email=…    + not on list  → "not on the list yet" → offer waitlist
 *   ?waitlist=1&email=…        → request-an-invite form (email + goal)
 *   ?done=1                    → waitlist confirmed
 *
 * Visual language matches the landing page (forest accent, Geist, paper bg).
 * Chrome is SiteShell; the .sg-* content classes live in globals.css.
 */

// ── server actions ──────────────────────────────────────────────────────────
async function handleEmailSubmit(formData: FormData) {
  'use server';
  const raw = formData.get('email');
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!email) return;
  redirect(`/signup?email=${encodeURIComponent(email)}`);
}

async function joinWaitlist(formData: FormData) {
  'use server';
  const rawEmail = formData.get('email');
  const rawGoal = formData.get('goal');
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  const goal = typeof rawGoal === 'string' ? rawGoal.trim() : '';
  if (!email) return;

  const db = supabaseAdmin();
  // Idempotent: a repeat request just refreshes the note. See the `waitlist`
  // migration (20260603000001_waitlist.sql). Unique constraint on email.
  // Check existence first so a repeat submission (just a goal edit) doesn't
  // re-alert David.
  const { data: existing } = await db
    .from('waitlist')
    .select('email')
    .eq('email', email)
    .maybeSingle();

  const { error } = await db
    .from('waitlist')
    .upsert({ email, goal: goal || null }, { onConflict: 'email' });

  if (error) {
    throw new Error(`Failed to add to waitlist: ${error.message}`);
  }

  if (!existing) {
    try {
      await sendDavidAlert(
        `New waitlist signup: ${email}${goal ? `\nTraining for: ${goal}` : ''}`,
      );
    } catch (err) {
      // A failed alert shouldn't block the signup confirmation.
      console.error('[signup] waitlist alert failed', err);
    }
  }

  redirect('/signup?done=1');
}

// ── small presentational helpers ────────────────────────────────────────────
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

// ── page ─────────────────────────────────────────────────────────────────────
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; waitlist?: string; done?: string }>;
}) {
  const params = await searchParams;
  const email = params.email?.trim().toLowerCase();

  // 5 · waitlist confirmed
  if (params.done) {
    return (
      <SiteShell>
        <div className="sg-badge sg-badge-ok">
          <Check /> You&apos;re on the list
        </div>
        <h1 className="sg-title">Got it — thank you.</h1>
        <p className="sg-lede">
          Daybreak is still just in testing with friends and family. We&apos;ll be in touch when
          we&apos;re ready for more people.
        </p>
        <Link href="/" className="sg-back">
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8.5 3L4.5 7l4 4" />
          </svg>
          Back to daybreak.run
        </Link>
      </SiteShell>
    );
  }

  // 4 · request-an-invite form
  if (params.waitlist) {
    return (
      <SiteShell>
        <div className="sg-eyebrow">Request an invite</div>
        <h1 className="sg-title">Get on the waitlist.</h1>
        <p className="sg-lede">Two quick things and you&apos;re done.</p>
        <form action={joinWaitlist}>
          <div className="sg-field">
            <label className="sg-label" htmlFor="wl-email">
              Email
            </label>
            <input
              type="email"
              name="email"
              id="wl-email"
              required
              defaultValue={email ?? ''}
              placeholder="you@email.com"
              autoComplete="email"
              className="sg-input"
            />
          </div>
          <div className="sg-field">
            <label className="sg-label" htmlFor="wl-goal">
              What are you training for?
            </label>
            <textarea
              name="goal"
              id="wl-goal"
              className="sg-input sg-textarea"
              placeholder="First marathon this fall — coming back from a calf strain and trying not to repeat it."
            />
            <p className="sg-hint">
              A sentence is plenty. It helps us prioritize who to onboard next.
            </p>
          </div>
          <button type="submit" className="sg-btn sg-btn-primary">
            Request invite
          </button>
          <Link href="/signup" className="sg-btn sg-btn-ghost">
            Back
          </Link>
        </form>
      </SiteShell>
    );
  }

  // 1 · email entry
  if (!email) {
    return (
      <SiteShell>
        <div className="sg-eyebrow">Invite only</div>
        <h1 className="sg-title">
          Let&apos;s get you <span className="sg-accent">running</span>.
        </h1>
        <p className="sg-lede">
          Daybreak is friends-only. Enter your email and we&apos;ll check your invite.
        </p>
        <form action={handleEmailSubmit}>
          <div className="sg-field">
            <input
              type="email"
              name="email"
              required
              placeholder="you@email.com"
              autoComplete="email"
              className="sg-input"
            />
          </div>
          <button type="submit" className="sg-btn sg-btn-primary">
            Check my invite <span className="sg-arrow">→</span>
          </button>
        </form>
      </SiteShell>
    );
  }

  // look up the allow-list
  const db = supabaseAdmin();
  const { data: row } = await db
    .from('friend_allowlist')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  // 3 · not on the list → offer waitlist
  if (!row) {
    return (
      <SiteShell>
        <div className="sg-badge sg-badge-info">Not on the list yet</div>
        <h1 className="sg-title">
          We don&apos;t see <span className="sg-accent">{email}</span>{' '}
          yet.
        </h1>
        <p className="sg-lede">
          Daybreak is invite-only while it&apos;s just friends and family. Want me to add you to the
          waitlist? I&apos;ll reach out as soon as there&apos;s room.
        </p>
        <Link
          href={`/signup?waitlist=1&email=${encodeURIComponent(email)}`}
          className="sg-btn sg-btn-primary"
        >
          Join the waitlist <span className="sg-arrow">→</span>
        </Link>
        <Link href="/signup" className="sg-btn sg-btn-ghost">
          Try a different email
        </Link>
      </SiteShell>
    );
  }

  // 2 · on the list → mint token + success (unchanged behavior, restyled)
  const token = randomBytes(32).toString('base64url');
  // Server Component runs once per request — Date.now() is fine here, but the
  // React purity lint rule fires regardless.
  // eslint-disable-next-line react-hooks/purity
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const { error: insertError } = await db
    .from('link_tokens')
    .insert({ email, token, expires_at: expiresAt });
  if (insertError) {
    throw new Error(`Failed to mint link token: ${insertError.message}`);
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? '';
  const deeplink = `tg://resolve?domain=${botUsername}&start=${token}`;
  const qrDataUrl = await QRCode.toDataURL(deeplink, {
    width: 220,
    margin: 1,
    color: { dark: '#1a1815', light: '#ffffff' },
  });

  return (
    <SiteShell>
      <div className="sg-badge sg-badge-ok">
        <Check /> You&apos;re on the list
      </div>
      <h1 className="sg-title">You&apos;re in.</h1>
      <p className="sg-lede">
        Daybreak runs in Telegram. You&apos;ll need to download it and then use the link below to
        finish your setup. <span className="sg-em">The link expires in 15 minutes.</span>
      </p>
      <a href={deeplink} className="sg-btn sg-btn-tg">
        <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17">
          <path d="M21.94 4.5L18.6 19.2c-.25 1.1-.92 1.37-1.86.86l-5.13-3.78-2.48 2.39c-.27.27-.5.5-1.03.5l.37-5.2L18 5.6c.4-.36-.09-.56-.62-.2L6.04 12.6l-5.06-1.58c-1.1-.34-1.12-1.1.23-1.62L20.5 2.9c.92-.34 1.72.22 1.44 1.6z" />
        </svg>
        Open in Telegram
      </a>
      <div className="sg-qr-block">
        <div className="sg-qr-label">On desktop? Scan with your phone:</div>
        <div className="sg-qr-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrDataUrl} alt="Telegram setup QR code" className="sg-qr" />
          <p className="sg-qr-side">Opens the same Telegram setup link on your mobile.</p>
        </div>
        <div className="sg-expire">
          <span className="sg-dot" /> expires in 15 minutes
        </div>
      </div>
    </SiteShell>
  );
}
