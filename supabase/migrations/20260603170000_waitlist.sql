-- Waitlist table for the /signup "request an invite" flow.
-- Someone whose email isn't on friend_allowlist can leave their email + a note
-- about what they're training for. Writes happen server-side via the
-- service-role key (supabaseAdmin()), so RLS stays restrictive (no public
-- policies). Query it directly in Supabase — there's no admin console.

create table if not exists public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  goal        text,
  created_at  timestamptz not null default now()
);

alter table public.waitlist enable row level security;
