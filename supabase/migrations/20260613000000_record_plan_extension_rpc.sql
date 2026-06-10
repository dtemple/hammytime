-- Atomic stored procedure for a deterministic open-ended plan extension (GF-W1).
--
-- The worker re-renders a continuation block through the template renderer,
-- merges it onto the working plan JSON, and publishes the result here. Mirrors
-- record_plan_edit with two deliberate differences:
--
--   * generated_by = 'template' — this is the renderer's output, not a coach
--     edit, and getActiveTemplatePlan-style checks should treat it as such.
--   * plans.baseline_version_id moves to the new version. Drift measured
--     against an exhausted block is meaningless once most of the plan is
--     continuation weeks — this is the re-baseline action deferred in v0.7.11,
--     scoped to extension only. record_plan_edit intentionally never touches
--     the baseline, which is why this is a separate function, not a parameter.
--
-- A pending proposed_version_id is left alone: promote_proposed_version's
-- staleness guard (supersedes_id <> current_version_id) discards it correctly
-- if the athlete taps Yes after the extension lands.

create or replace function record_plan_extension(
  p_plan_id               uuid,
  p_plan_json             jsonb,
  p_supersedes_version_id uuid,
  p_total_weeks           int,
  p_start_date            date
) returns uuid
language plpgsql
as $$
declare
  v_new_id       uuid;
  v_next_version int;
begin
  select coalesce(max(version), 0) + 1
  into v_next_version
  from plan_versions
  where plan_id = p_plan_id;

  insert into plan_versions (plan_id, version, plan_json, generated_by, status, supersedes_id)
  values (p_plan_id, v_next_version, p_plan_json, 'template', 'active', p_supersedes_version_id)
  returning id into v_new_id;

  if p_supersedes_version_id is not null then
    update plan_versions
    set status = 'superseded'
    where id = p_supersedes_version_id;
  end if;

  update plans
  set
    current_version_id  = v_new_id,
    baseline_version_id = v_new_id,
    start_date          = p_start_date,
    weeks               = p_total_weeks,
    updated_at          = now()
  where id = p_plan_id;

  return v_new_id;
end;
$$;

-- The 20260609 blanket revoke only covered functions that existed then — a
-- later-created function gets the implicit PUBLIC execute grant again, so
-- lock this one down explicitly (same pattern as calendar_confirm_propose).
revoke execute on function record_plan_extension(uuid, jsonb, uuid, int, date) from public, anon, authenticated;
grant execute on function record_plan_extension(uuid, jsonb, uuid, int, date) to service_role;
