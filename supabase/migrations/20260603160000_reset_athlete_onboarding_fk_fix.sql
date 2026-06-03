-- Fix reset_athlete_onboarding: deleting plan_versions tripped
-- plans_baseline_version_id_fkey. The plans table has two FKs into plan_versions:
--   - current_version_id  → ON DELETE SET NULL (clears itself, fine)
--   - baseline_version_id  → no ON DELETE action (RESTRICT) → blocks the delete
-- (added later in 20260602000000_plan_baseline_version.sql).
--
-- Clear both pointers on the athlete's plans before deleting the versions, so the
-- delete can't trip either FK. Everything else matches the prior definition.
create or replace function reset_athlete_onboarding(
  p_athlete_id uuid
) returns void
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('athlete:' || p_athlete_id::text));

  -- Break the plans → plan_versions references before deleting the versions.
  update plans
     set current_version_id  = null,
         baseline_version_id = null
   where athlete_id = p_athlete_id;

  delete from plan_versions
   where plan_id in (select id from plans where athlete_id = p_athlete_id);
  delete from plans                    where athlete_id = p_athlete_id;
  delete from races                    where athlete_id = p_athlete_id;
  delete from injuries                 where athlete_id = p_athlete_id;
  delete from memory_files             where athlete_id = p_athlete_id;
  delete from athlete_training_profile where athlete_id = p_athlete_id;

  -- job_queue has no athlete_id column; the athlete rides in the JSON payload.
  -- Drop only jobs that haven't completed, so a stale enqueued run can't fire
  -- against the half-reset athlete mid-re-onboard.
  delete from job_queue
   where completed_at is null
     and payload->>'athlete_id' = p_athlete_id::text;

  update athletes
     set onboarding_state = '{"step": 0, "partial": {}}'::jsonb,
         checkin_state    = '{}'::jsonb,
         updated_at        = now()
   where id = p_athlete_id;
end;
$$;
