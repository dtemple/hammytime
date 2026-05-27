import { randomBytes } from 'crypto';
import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { supabaseAdmin } from '@/lib/db';

async function handleEmailSubmit(formData: FormData) {
  'use server';
  const raw = formData.get('email');
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!email) return;
  redirect(`/signup?email=${encodeURIComponent(email)}`);
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const { email: rawEmail } = await searchParams;
  const email = rawEmail?.trim().toLowerCase();

  if (!email) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-white px-4">
        <div className="w-full max-w-sm">
          <p className="text-sm text-zinc-500 mb-1">
            Daily Telegram coaching for marathon runners.
          </p>
          <p className="text-sm text-zinc-500 mb-1">Powered by your Strava data.</p>
          <p className="text-sm text-zinc-500 mb-6">Friends only, by invite.</p>
          <form action={handleEmailSubmit}>
            <input
              type="email"
              name="email"
              required
              placeholder="your@email.com"
              className="w-full border border-zinc-300 rounded px-3 py-2 text-sm mb-3 outline-none focus:border-zinc-600"
            />
            <button
              type="submit"
              className="w-full bg-zinc-900 text-white text-sm rounded px-3 py-2 hover:bg-zinc-700 transition-colors"
            >
              Check my invite
            </button>
          </form>
        </div>
      </main>
    );
  }

  const db = supabaseAdmin();
  const { data: row } = await db
    .from('friend_allowlist')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (!row) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-white px-4">
        <div className="w-full max-w-sm">
          <p className="text-sm text-zinc-800 mb-2">{email} isn&apos;t on the list yet.</p>
          <p className="text-sm text-zinc-500">Ping David to get an invite added.</p>
        </div>
      </main>
    );
  }

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
  const qrDataUrl = await QRCode.toDataURL(deeplink, { width: 200, margin: 2 });

  return (
    <main className="min-h-screen flex items-center justify-center bg-white px-4">
      <div className="w-full max-w-sm">
        <p className="text-sm text-zinc-500 mb-4">
          You&apos;re on the list. Tap the link to open Telegram and start setup — it expires in 15
          minutes.
        </p>
        <a
          href={deeplink}
          className="block w-full bg-zinc-900 text-white text-sm text-center rounded px-3 py-2 mb-6 hover:bg-zinc-700 transition-colors"
        >
          Open in Telegram
        </a>
        <p className="text-xs text-zinc-400 mb-2">On desktop? Scan with your phone:</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrDataUrl} alt="Telegram deeplink QR code" className="w-40 h-40" />
      </div>
    </main>
  );
}
