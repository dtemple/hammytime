import type { Metadata } from 'next';
import { SiteShell } from '@/components/SiteShell';

export const metadata: Metadata = {
  title: 'Payment received — Daybreak',
};

// Stripe Checkout's success_url lands here (set in src/server/billing/checkout.ts).
// Purely informational — the webhook does the crediting + sends the Telegram
// confirmation. Mirrors the Strava /strava/connected page: bare logo + card, no nav.
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

export default function CheckoutSuccessPage() {
  return (
    <SiteShell nav={false} footer={false}>
      <div className="sg-badge sg-badge-ok">
        <Check /> Payment received
      </div>
      <h1 className="sg-title">You&apos;re topped up.</h1>
      <p className="sg-lede">
        Your credit&rsquo;s been added. Head back to Telegram to keep working with Daybreak —
        your updated balance and a confirmation are waiting there.
      </p>
    </SiteShell>
  );
}
