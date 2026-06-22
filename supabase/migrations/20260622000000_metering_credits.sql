-- ---------------------------------------------------------------------------
-- Metering & payments — step 1 of Specs/METERING_PAYMENTS.md §12.
--
-- Adds the two billing tables from §4:
--   athlete_credits — live balance (a cache for the hot path)
--   credit_ledger   — append-only audit; the source of truth balance is rebuilt from
--
-- Plus the idempotent $5 signup grant (grant_signup_credit) and a backfill that
-- grants every existing athlete exactly one grant. No draw-down, no Stripe, no
-- gate — those are later steps (§5+). Cents only; no floats on money.
--
-- RLS convention (matches the rest of the schema): enable RLS, no policies. All
-- access is via the service-role key (supabaseAdmin()), which bypasses RLS; the
-- anon/authenticated PostgREST path is denied.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- athlete_credits — live balance (cache). One row per athlete.
-- ---------------------------------------------------------------------------
create table athlete_credits (
  athlete_id                  uuid        primary key references athletes(id) on delete cascade,
  balance_cents               int         not null default 0,
  comped                      boolean     not null default false,
  stripe_customer_id          text,                                  -- set on first Checkout
  auto_reload_enabled         boolean     not null default false,
  auto_reload_threshold_cents int         not null default 300,      -- $3
  auto_reload_amount_cents    int         not null default 2500,     -- $25
  default_pm_id               text,                                  -- saved card for off-session
  low_balance_warned_at       timestamptz,                           -- dedupe the ~1wk heads-up
  updated_at                  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- credit_ledger — append-only audit. Every balance mutation writes a row here.
-- ---------------------------------------------------------------------------
create table credit_ledger (
  id                    uuid        primary key default gen_random_uuid(),
  athlete_id            uuid        not null references athletes(id) on delete cascade,
  kind                  text        not null
                                    check (kind in ('grant', 'topup', 'debit', 'refund', 'adjust')),
  amount_cents          int         not null,                        -- signed: +credit, -debit
  balance_after_cents   int         not null,
  related_run_id        uuid        references agent_runs(id) on delete set null,  -- for debits
  stripe_payment_intent text,                                        -- for topups/refunds
  note                  text,
  created_at            timestamptz not null default now()
);

create index credit_ledger_athlete_created_idx on credit_ledger (athlete_id, created_at desc);

-- Idempotency guard for the signup grant: exactly one kind='grant' row per
-- athlete, ever — enforced in the DB, not just app logic. A concurrent second
-- grant fails here and rolls back its balance bump (see grant_signup_credit).
create unique index credit_ledger_one_grant_per_athlete on credit_ledger (athlete_id)
  where kind = 'grant';

alter table athlete_credits enable row level security;
alter table credit_ledger   enable row level security;

-- ---------------------------------------------------------------------------
-- grant_signup_credit — idempotent $5 grant.
--
-- Writes BOTH the ledger row (source of truth) and the balance cache in one
-- transaction. Idempotent: a fast existence check handles the common case; the
-- partial unique index above is the real guard against a concurrent double-grant
-- (the duplicate ledger insert raises unique_violation, which rolls the whole
-- function back to a no-op). Returns true if it granted, false if already granted.
--
-- SECURITY INVOKER + called only as service_role via supabaseAdmin().rpc(...),
-- matching the other RPCs (see 20260609000000_rls_remaining_tables_and_rpc_grants).
-- ---------------------------------------------------------------------------
create or replace function grant_signup_credit(
  p_athlete_id  uuid,
  p_amount_cents int default 500
)
returns boolean
language plpgsql
security invoker
as $$
declare
  v_new_balance int;
begin
  -- Fast path: already granted → idempotent no-op.
  if exists (
    select 1 from credit_ledger where athlete_id = p_athlete_id and kind = 'grant'
  ) then
    return false;
  end if;

  -- Cache (athlete_credits): create the row or bump an existing balance.
  insert into athlete_credits (athlete_id, balance_cents, updated_at)
  values (p_athlete_id, p_amount_cents, now())
  on conflict (athlete_id) do update
    set balance_cents = athlete_credits.balance_cents + excluded.balance_cents,
        updated_at    = now()
  returning balance_cents into v_new_balance;

  -- Source of truth (credit_ledger): append the grant with the running balance.
  -- If a concurrent call already inserted a grant, this violates the partial
  -- unique index and the exception handler below rolls back the bump above.
  insert into credit_ledger (athlete_id, kind, amount_cents, balance_after_cents, note)
  values (p_athlete_id, 'grant', p_amount_cents, v_new_balance, 'signup grant');

  return true;
exception
  when unique_violation then
    -- Lost a concurrent race; the other transaction did the grant. No-op.
    return false;
end;
$$;

-- Service-role-only execute, matching the convention from
-- 20260609000000_rls_remaining_tables_and_rpc_grants.sql.
revoke execute on function grant_signup_credit(uuid, int) from public, anon, authenticated;
grant  execute on function grant_signup_credit(uuid, int) to service_role;

-- ---------------------------------------------------------------------------
-- Backfill: one $5 grant per existing athlete. Idempotent via the RPC + the
-- partial unique index — safe to re-run.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select id from athletes loop
    perform grant_signup_credit(r.id, 500);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Comp David (real dev/tester + the test/group athlete). comped = true skips all
-- billing — no debit, no warning, no gate. The 6 friends stay comped=false with
-- their $5 grant so step 2's draw-down exercises against live traffic.
--   8940829310 = real David (DAVID_TELEGRAM_CHAT_ID)
--   negative telegram_chat_id = test/group athletes
-- ---------------------------------------------------------------------------
update athlete_credits
set comped     = true,
    updated_at = now()
where athlete_id in (
  select id from athletes
  where telegram_chat_id = '8940829310'
     or telegram_chat_id like '-%'
);
