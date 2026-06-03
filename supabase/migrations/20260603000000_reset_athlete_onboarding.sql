-- Transactional hard reset of an athlete's onboarding-derived data, so /restart
-- (and the test-reset script) re-run onboarding from a clean slate instead of
-- leaving duplicate races/injuries behind. Before this, /restart only reset
-- onboarding_state to step 0, and steps 01/03 re-INSERT a race and an injury
-- unconditionally — so each re-onboard accumulated a duplicate row.
--
-- The per-athlete advisory lock mirrors set_onboarding_state; the whole function
-- body runs in one transaction (rolled back on error).
--
-- Clears: plan_versions (via the athlete's plans), plans, races, injuries,
--   memory_files, athlete_training_profile, and not-yet-completed job_queue rows
--   for this athlete (athlete_id lives in the job payload).
-- Resets: onboarding_state -> step 0, checkin_state -> {}.
-- Preserves: the athletes row, Strava oauth_tokens, activities, messages,
--   agent_runs / agent_run_steps, link_tokens.
create or replace function reset_athlete_onboarding(
  p_athlete_id uuid
) returns void
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('athlete:' || p_athlete_id::text));

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
