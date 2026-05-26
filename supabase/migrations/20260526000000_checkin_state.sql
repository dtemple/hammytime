-- v0.7: add checkin_state column for the wellness battery state machine.
-- Empty {} means no active check-in. Sub-steps are written via direct .update()
-- calls from the dispatcher — no RPC needed (single-column, no cross-table txn).

alter table athletes
  add column checkin_state jsonb not null default '{}'::jsonb;
