-- Atomically writes onboarding_state with a per-athlete advisory lock.
-- The lock serialises concurrent writes (e.g. two rapid Telegram messages, or
-- an onboarding message racing the Week 3 daily agent run for the same athlete).
-- The advisory lock is transaction-scoped and released on commit.
create or replace function set_onboarding_state(
  p_athlete_id uuid,
  p_new_state  jsonb
) returns void
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('athlete:' || p_athlete_id::text));
  update athletes
  set onboarding_state = p_new_state,
      updated_at        = now()
  where id = p_athlete_id;
end;
$$;
