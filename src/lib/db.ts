import { createClient } from '@supabase/supabase-js';

export function supabaseAdmin() {
  if (typeof window !== 'undefined') {
    throw new Error(
      'supabaseAdmin() must only be called server-side — it uses the service role key',
    );
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}
