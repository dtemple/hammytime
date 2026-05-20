-- Stored procedure for the /start handshake.
-- Runs the entire token validation + user/athlete upsert as a single transaction.
-- Returns jsonb: { ok: bool, reason?: text, athlete_id?: uuid, email?: text }

create or replace function link_start_handshake(
  p_token            text,
  p_telegram_chat_id text
) returns jsonb
language plpgsql
as $$
declare
  v_link       link_tokens%rowtype;
  v_user_id    uuid;
  v_athlete_id uuid;
begin
  -- Lock the token row to prevent concurrent /start races
  select * into v_link
  from link_tokens
  where token = p_token
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_link.used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_used');
  end if;

  if v_link.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  -- Mark token consumed
  update link_tokens
  set used_at = now()
  where id = v_link.id;

  -- Upsert user by email
  insert into users (email)
  values (v_link.email)
  on conflict (email) do nothing;

  select id into v_user_id
  from users
  where email = v_link.email;

  -- Find or create athlete for this user
  select id into v_athlete_id
  from athletes
  where user_id = v_user_id;

  if not found then
    insert into athletes (
      user_id, name, onboarding_state, telegram_chat_id, shadow_bcc_until
    ) values (
      v_user_id,
      '(pending)',
      '{"step": 0, "partial": {}}'::jsonb,
      p_telegram_chat_id,
      now() + interval '7 days'
    )
    returning id into v_athlete_id;
  else
    -- Re-linking or re-onboarding: update chat id and reset state
    update athletes
    set telegram_chat_id = p_telegram_chat_id,
        onboarding_state  = '{"step": 0, "partial": {}}'::jsonb,
        updated_at        = now()
    where id = v_athlete_id;
  end if;

  -- Backfill athlete_id on the token row
  update link_tokens
  set athlete_id = v_athlete_id
  where id = v_link.id;

  return jsonb_build_object(
    'ok',         true,
    'athlete_id', v_athlete_id::text,
    'email',      v_link.email
  );
end;
$$;
