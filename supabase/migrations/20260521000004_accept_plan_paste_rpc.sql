-- v0.4.1: atomic stored procedure for accepting a pasted plan
-- Updates plan_versions + plans + link_tokens in a single transaction

create or replace function accept_plan_paste(
  p_link_token_id   uuid,
  p_plan_version_id uuid,
  p_plan_id         uuid,
  p_plan_json       jsonb,
  p_total_weeks     int,
  p_start_date      date
) returns void
language plpgsql
as $$
begin
  -- Flip plan_versions to active with the validated JSON
  update plan_versions
  set
    plan_json = p_plan_json,
    status    = 'active'
  where id = p_plan_version_id;

  -- Update plans with the new current version, start date, and week count
  update plans
  set
    current_version_id = p_plan_version_id,
    start_date         = p_start_date,
    weeks              = p_total_weeks,
    updated_at         = now()
  where id = p_plan_id;

  -- Mark the one-time paste token as used
  update link_tokens
  set used_at = now()
  where id = p_link_token_id;
end;
$$;
