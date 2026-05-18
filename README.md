# hammytime

Hammytime is a multi-tenant Telegram-based marathon coaching bot built for a small, friends-only group of athletes. The full product spec — architecture decisions, scope locks, database schema, and agent loop design — lives in [Specs/SPEC.md](Specs/SPEC.md). This is the Next.js 15 web app that handles allowlist signup, Strava OAuth handoff, a read-only plan view, and a David-only admin console; the coaching product itself is delivered entirely through Telegram.

## Local development

### 1. Start the local database

```bash
npx supabase start
```

This spins up a local Postgres instance via Docker. The first run pulls images and takes a minute.

### 2. Populate `.env.local`

After `supabase start` finishes, run:

```bash
npx supabase status
```

Copy the values into a new `.env.local` file (see `.env.example` for the full key list):

```
NEXT_PUBLIC_SUPABASE_URL=<API URL from supabase status>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from supabase status>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase status>
```

### 3. Verify the database connection

```bash
npm run db:smoke
```

Should print `db-smoke: connection OK` and exit 0. If it fails, check that `supabase start` completed and your `.env.local` keys match `supabase status` output.
