-- Atomic stored procedure for a coach-authored plan edit.
--
-- The worker validates the agent's edited plan JSON against PlanSchema, then
-- calls this to publish it as the new working version. Mirrors
-- accept_plan_paste, but appends a brand-new version (rather than flipping an
-- awaiting_paste row) and supersedes the prior current version. The original
-- baseline_version_id is intentionally left untouched.

create or replace function record_plan_edit(
  p_plan_id               uuid,
  p_plan_json             jsonb,
  p_supersedes_version_id uuid,
  p_total_weeks           int,
  p_start_date            date
) returns uuid
language plpgsql
as $$
declare
  v_new_id      uuid;
  v_next_version int;
begin
  select coalesce(max(version), 0) + 1
  into v_next_version
  from plan_versions
  where plan_id = p_plan_id;

  insert into plan_versions (plan_id, version, plan_json, generated_by, status, supersedes_id)
  values (p_plan_id, v_next_version, p_plan_json, 'coach_agent', 'active', p_supersedes_version_id)
  returning id into v_new_id;

  -- Retire the version we just superseded.
  if p_supersedes_version_id is not null then
    update plan_versions
    set status = 'superseded'
    where id = p_supersedes_version_id;
  end if;

  update plans
  set
    current_version_id = v_new_id,
    start_date         = p_start_date,
    weeks              = p_total_weeks,
    updated_at         = now()
  where id = p_plan_id;

  return v_new_id;
end;
$$;
