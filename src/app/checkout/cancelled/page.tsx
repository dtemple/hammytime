import type { Metadata } from 'next';
import { SiteShell } from '@/components/SiteShell';

export const metadata: Metadata = {
  title: 'Checkout cancelled — Daybreak',
};

// Stripe Checkout's cancel_url lands here (set in src/server/billing/checkout.ts)
// when a friend backs out before paying. No charge happens. Mirrors the success
// page and /strava/connected: bare logo + card, no nav.
export default function CheckoutCancelledPage() {
  return (
    <SiteShell nav={false} footer={false}>
      <div className="sg-badge sg-badge-info">Checkout cancelled</div>
      <h1 className="sg-title">No charge made.</h1>
      <p className="sg-lede">
        You weren&rsquo;t charged. Head back to Telegram and run <span className="sg-em">/buy</span>{' '}
        whenever you want to add credit.
      </p>
    </SiteShell>
  );
}
