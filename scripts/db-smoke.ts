import { config } from 'dotenv';
config({ path: '.env.local' });
import { supabaseAdmin } from '../src/lib/db';

async function main() {
  const client = supabaseAdmin();

  // Query a non-existent table: a "relation does not exist" error (42P01)
  // still proves we connected to Postgres successfully.
  const { error } = await client.from('_smoke_probe').select('*').limit(1);

  // PGRST205 = table not in schema cache (PostgREST); 42P01 = relation does not exist (Postgres)
  // Either proves we reached the server successfully.
  if (!error || error.code === '42P01' || error.code === 'PGRST205') {
    console.log('db-smoke: connection OK');
    process.exit(0);
  } else {
    console.error('db-smoke: connection failed', error);
    process.exit(1);
  }
}

main();
