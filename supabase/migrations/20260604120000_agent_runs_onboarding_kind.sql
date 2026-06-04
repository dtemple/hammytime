-- V3-W2: the onboarding v3 per-turn engine logs each Sonnet `extract_and_advance`
-- turn to agent_runs (kind 'onboarding') for cost tracking.
--
-- The original CHECK only allowed ('daily','adhoc','weekly','plan_validate'). Two
-- kinds are already inserted in code but absent from the constraint:
--   - 'race_lookup' (src/server/agent/race-lookup.ts) — its inserts violate the
--     CHECK and silently fail (the call is wrapped in .catch), so race-lookup cost
--     has never actually persisted. This restores it.
--   - 'onboarding' (new, this workstream).

alter table agent_runs drop constraint if exists agent_runs_kind_check;

alter table agent_runs
  add constraint agent_runs_kind_check
  check (kind in ('daily', 'adhoc', 'weekly', 'plan_validate', 'race_lookup', 'onboarding'));
