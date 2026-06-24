-- ---------------------------------------------------------------------------
-- Metering & payments — step 7 of Specs/METERING_PAYMENTS.md §12 (§11: admin).
--
-- Adds the manual-adjust RPC the David-only admin console calls for comps and
-- make-goods:
--   adjust_credit(athlete_id, amount_cents signed, note) — writes one
--   kind='adjust' ledger row AND bumps athlete_credits.balance_cents in a single
--   transaction, mirroring grant_signup_credit / debit_run_credit. Returns the
--   new balance.
--
-- This is the one new DB primitive step 7 needs. Unlike grant/debit/topup there
-- is NO idempotency index: a manual adjust is a deliberate, repeatable action
-- (David may credit the same athlete twice on purpose), so each call appends a
-- distinct ledger row. The required note is the audit trail.
--
-- amount_cents is SIGNED: a positive adjust credits the athlete (a comp / make-
-- good), a negative one debits (a correction). Cents only; no floats on money.
--
-- A note is REQUIRED — a manual money movement with no reason is exactly the row
-- a future audit can't explain — so a null/blank note raises rather than writing.
-- A zero amount is rejected too (nothing to record).
--
-- Deliberately does NOT short-circuit on comped: an adjust is an explicit manual
-- override (e.g. seeding a balance before flipping a friend off comp, or a make-
-- good for a comped tester), so it always applies. comped only skips AUTOMATIC
-- billing (debits), which is enforced in debit_run_credit, not here.
--
-- SECURITY INVOKER + service_role-only execute, matching the other money RPCs.
-- ---------------------------------------------------------------------------
create or replace function adjust_credit(
  p_athlete_id   uuid,
  p_amount_cents int,
  p_note         text
)
returns int
language plpgsql
security invoker
as $$
declare
  v_new_balance int;
begin
  if p_note is null or btrim(p_note) = '' then
    raise exception 'adjust_credit requires a non-empty note';
  end if;
  if p_amount_cents is null or p_amount_cents = 0 then
    raise exception 'adjust_credit requires a non-zero amount';
  end if;

  -- Cache (athlete_credits): bump the balance by the signed amount. The row
  -- exists for every onboarded athlete (the signup grant created it); the insert
  -- branch only fires for the degenerate no-row case.
  insert into athlete_credits (athlete_id, balance_cents, updated_at)
  values (p_athlete_id, p_amount_cents, now())
  on conflict (athlete_id) do update
    set balance_cents = athlete_credits.balance_cents + p_amount_cents,
        updated_at    = now()
  returning balance_cents into v_new_balance;

  -- Source of truth (credit_ledger): append the signed adjust row with its note.
  insert into credit_ledger (
    athlete_id, kind, amount_cents, balance_after_cents, note
  )
  values (
    p_athlete_id, 'adjust', p_amount_cents, v_new_balance, btrim(p_note)
  );

  return v_new_balance;
end;
$$;

revoke execute on function adjust_credit(uuid, int, text) from public, anon, authenticated;
grant  execute on function adjust_credit(uuid, int, text) to service_role;
