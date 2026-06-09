-- Calendar-confirm: propose→confirm plan edits (Specs/CALENDAR_CONFIRM.md).
--
-- A coach plan edit is no longer activated directly. The worker stages it as a
-- 'proposed' plan_versions row (propose_plan_edit); the athlete confirms with a
-- tap, which promotes it to active (promote_proposed_version) or discards it
-- (discard_proposed_version). current_version_id — and therefore the calendar —
-- only moves on promote. record_plan_edit stays for now; the worker switches to
-- the propose path in the cutover deploy.

-- Two new version states: 'proposed' (staged candidate, awaiting the tap) and
-- 'discarded' (a candidate that was declined, expired, or superseded by a newer
-- proposal — distinct from 'superseded', which means "was active, replaced").
alter table plan_versions
  drop constraint plan_versions_status_check;

alter table plan_versions
  add constraint plan_versions_status_check
  check (status in ('awaiting_paste', 'active', 'superseded', 'proposed', 'discarded'));

-- The outstanding proposal, at most one per plan. proposed_token is the short
-- secret carried in the Telegram callback_data; proposed_message_id is the
-- chat message holding the confirm keyboard (set by the worker after send, so
-- a superseding proposal can edit the stale keyboard message).
alter table plans
  add column proposed_version_id uuid references plan_versions(id) on delete set null,
  add column proposed_token      text,
  add column proposed_expires_at timestamptz,
  add column proposed_message_id bigint;

-- Stage a coach edit as a candidate. Supersedes any prior outstanding proposal;
-- never touches current_version_id. p_based_on_version_id records the active
-- version the candidate was built against (stored in supersedes_id) so promote
-- can detect staleness.
create or replace function propose_plan_edit(
  p_plan_id             uuid,
  p_plan_json           jsonb,
  p_based_on_version_id uuid,
  p_token               text,
  p_expires_at          timestamptz
) returns uuid
language plpgsql
as $$
declare
  v_new_id       uuid;
  v_next_version int;
  v_prior        uuid;
begin
  -- One outstanding proposal at a time: discard the prior candidate, if any.
  select proposed_version_id into v_prior from plans where id = p_plan_id;
  if v_prior is not null then
    update plan_versions set status = 'discarded' where id = v_prior;
  end if;

  select coalesce(max(version), 0) + 1
  into v_next_version
  from plan_versions
  where plan_id = p_plan_id;

  insert into plan_versions (plan_id, version, plan_json, generated_by, status, supersedes_id)
  values (p_plan_id, v_next_version, p_plan_json, 'coach_agent', 'proposed', p_based_on_version_id)
  returning id into v_new_id;

  update plans
  set
    proposed_version_id = v_new_id,
    proposed_token      = p_token,
    proposed_expires_at = p_expires_at,
    proposed_message_id = null,
    updated_at          = now()
  where id = p_plan_id;

  return v_new_id;
end;
$$;

-- Promote the outstanding candidate to active (the athlete tapped Yes).
-- Idempotent: a cleared/mismatched token is 'not_found', not an error, so
-- re-taps and webhook retries are safe. A candidate past its expiry or built
-- against a version that is no longer current is dead — discard it and report
-- why, never blind-apply it.
create or replace function promote_proposed_version(
  p_plan_id uuid,
  p_token   text
) returns text
language plpgsql
as $$
declare
  v_version_id  uuid;
  v_expires_at  timestamptz;
  v_based_on    uuid;
  v_current     uuid;
  v_plan_json   jsonb;
begin
  select proposed_version_id, proposed_expires_at, current_version_id
  into v_version_id, v_expires_at, v_current
  from plans
  where id = p_plan_id
    and proposed_token = p_token
    and proposed_version_id is not null;

  if v_version_id is null then
    return 'not_found';
  end if;

  select supersedes_id, plan_json
  into v_based_on, v_plan_json
  from plan_versions
  where id = v_version_id;

  if v_expires_at is not null and v_expires_at < now() then
    update plan_versions set status = 'discarded' where id = v_version_id;
    update plans
    set proposed_version_id = null, proposed_token = null,
        proposed_expires_at = null, proposed_message_id = null
    where id = p_plan_id;
    return 'expired';
  end if;

  if v_based_on is distinct from v_current then
    update plan_versions set status = 'discarded' where id = v_version_id;
    update plans
    set proposed_version_id = null, proposed_token = null,
        proposed_expires_at = null, proposed_message_id = null
    where id = p_plan_id;
    return 'stale';
  end if;

  update plan_versions set status = 'active' where id = v_version_id;

  if v_current is not null then
    update plan_versions set status = 'superseded' where id = v_current;
  end if;

  -- start_date/weeks come from the candidate itself — the row is self-contained.
  update plans
  set
    current_version_id  = v_version_id,
    start_date          = (v_plan_json->'metadata'->'plan_structure'->>'start_date')::date,
    weeks               = jsonb_array_length(v_plan_json->'weeks'),
    proposed_version_id = null,
    proposed_token      = null,
    proposed_expires_at = null,
    proposed_message_id = null,
    updated_at          = now()
  where id = p_plan_id;

  return 'promoted';
end;
$$;

-- Discard the outstanding candidate (the athlete tapped No). Same idempotency
-- contract as promote: cleared/mismatched token is a 'not_found' no-op.
create or replace function discard_proposed_version(
  p_plan_id uuid,
  p_token   text
) returns text
language plpgsql
as $$
declare
  v_version_id uuid;
begin
  select proposed_version_id
  into v_version_id
  from plans
  where id = p_plan_id
    and proposed_token = p_token
    and proposed_version_id is not null;

  if v_version_id is null then
    return 'not_found';
  end if;

  update plan_versions set status = 'discarded' where id = v_version_id;

  update plans
  set proposed_version_id = null, proposed_token = null,
      proposed_expires_at = null, proposed_message_id = null,
      updated_at = now()
  where id = p_plan_id;

  return 'discarded';
end;
$$;

-- The 20260609 blanket revoke only covered functions that existed then — a
-- later-created function gets the implicit PUBLIC execute grant again, so
-- lock these three down explicitly (service_role-only, like record_plan_edit).
revoke execute on function propose_plan_edit(uuid, jsonb, uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function promote_proposed_version(uuid, text) from public, anon, authenticated;
revoke execute on function discard_proposed_version(uuid, text) from public, anon, authenticated;

grant execute on function propose_plan_edit(uuid, jsonb, uuid, text, timestamptz) to service_role;
grant execute on function promote_proposed_version(uuid, text) to service_role;
grant execute on function discard_proposed_version(uuid, text) to service_role;
