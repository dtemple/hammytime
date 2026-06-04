/**
 * Manage the Strava push subscription (one per app).
 *
 * Strava allows exactly one webhook subscription per application. Creating a
 * second returns an error; delete the existing one first.
 *
 * Usage:
 *   npx tsx scripts/register-strava-webhook.ts create   # subscribe; Strava
 *                                                        # GETs our callback to
 *                                                        # validate the token
 *   npx tsx scripts/register-strava-webhook.ts list      # show current sub
 *   npx tsx scripts/register-strava-webhook.ts delete <id>
 *
 * Reads STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_WEBHOOK_VERIFY_TOKEN,
 * and NEXT_PUBLIC_APP_URL from .env.local. The callback must be publicly
 * reachable when you run `create` (deploy first, or use a tunnel).
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

const PUSH_SUBSCRIPTIONS_URL = 'https://www.strava.com/api/v3/push_subscriptions';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in .env.local`);
    process.exit(1);
  }
  return v;
}

function clientCreds(): { client_id: string; client_secret: string } {
  return {
    client_id: requireEnv('STRAVA_CLIENT_ID'),
    client_secret: requireEnv('STRAVA_CLIENT_SECRET'),
  };
}

/**
 * The callback Strava validates with a GET must answer 200 directly — it does
 * NOT follow redirects. Our apex (daybreak.run) 307s to www, so an apex callback
 * fails validation. Normalize a bare apex host (two labels, no subdomain) to www;
 * hosts that already have a subdomain (www.*, tunnels like *.ngrok.io) pass through.
 */
function canonicalCallback(appUrl: string): string {
  const u = new URL(`${appUrl.replace(/\/$/, '')}/api/strava/webhook`);
  if (!u.hostname.startsWith('www.') && u.hostname.split('.').length === 2) {
    u.hostname = `www.${u.hostname}`;
  }
  return u.toString();
}

async function create(): Promise<void> {
  const { client_id, client_secret } = clientCreds();
  const verifyToken = requireEnv('STRAVA_WEBHOOK_VERIFY_TOKEN');
  const callbackUrl = canonicalCallback(requireEnv('NEXT_PUBLIC_APP_URL'));

  console.log('Creating subscription with callback:', callbackUrl);
  const res = await fetch(PUSH_SUBSCRIPTIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id,
      client_secret,
      callback_url: callbackUrl,
      verify_token: verifyToken,
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`Create failed (${res.status}):`, body);
    process.exit(1);
  }
  console.log('Subscription created:', body);
}

async function list(): Promise<void> {
  const { client_id, client_secret } = clientCreds();
  const params = new URLSearchParams({ client_id, client_secret });
  const res = await fetch(`${PUSH_SUBSCRIPTIONS_URL}?${params}`);
  const body = await res.text();
  if (!res.ok) {
    console.error(`List failed (${res.status}):`, body);
    process.exit(1);
  }
  console.log('Current subscriptions:', body);
}

async function remove(id: string): Promise<void> {
  const { client_id, client_secret } = clientCreds();
  const params = new URLSearchParams({ client_id, client_secret });
  const res = await fetch(`${PUSH_SUBSCRIPTIONS_URL}/${id}?${params}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Delete failed (${res.status}):`, body);
    process.exit(1);
  }
  console.log(`Subscription ${id} deleted.`);
}

async function main() {
  const action = process.argv[2];
  switch (action) {
    case 'create':
      await create();
      break;
    case 'list':
      await list();
      break;
    case 'delete': {
      const id = process.argv[3];
      if (!id) {
        console.error('Usage: npx tsx scripts/register-strava-webhook.ts delete <id>');
        process.exit(1);
      }
      await remove(id);
      break;
    }
    default:
      console.error('Usage: npx tsx scripts/register-strava-webhook.ts <create|list|delete> [id]');
      process.exit(1);
  }
}

main();
