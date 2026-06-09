-- ---------------------------------------------------------------------------
-- Security hardening: enable RLS on the remaining PostgREST-exposed tables,
-- and lock down RPC execute grants.
--
-- Background: the initial schema enabled RLS on the 11 athlete-scoped tables
-- but left these service-role-only tables with RLS *off* (the TODO block said
-- "no per-row policies needed" — true, but RLS-off is not the same as
-- no-policies). With RLS off, the public anon key can read/write them via
-- PostgREST. Every data access in the app uses the service-role key
-- (supabaseAdmin()), which bypasses RLS, so enabling RLS with no policies
-- denies the anon path without affecting the app. Clears the Supabase linter
-- "RLS has not been enabled" warnings; matches the existing convention.
-- ---------------------------------------------------------------------------

alter table public.users            enable row level security;
alter table public.friend_allowlist enable row level security;
alter table public.link_tokens      enable row level security;
alter table public.job_queue        enable row level security;
alter table public.race_lookups     enable row level security;

-- ---------------------------------------------------------------------------
-- RPC execute grants. These functions are all SECURITY INVOKER and are called
-- only as service_role via supabaseAdmin().rpc(...):
--   accept_plan_paste, link_start_handshake, reset_athlete_onboarding,
--   record_plan_edit, set_onboarding_state, set_onboarding_state_if_substep,
--   claim_next_job.
-- Revoke the implicit PUBLIC EXECUTE grant (the thing that exposes them to the
-- anon/authenticated PostgREST roles) and grant execute back to service_role
-- only. Defense-in-depth on top of the RLS change above.
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
