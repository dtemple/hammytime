-- v0.5.0: allow 'calendar' as a link_tokens.purpose value
-- Calendar tokens are long-lived (5y) and reusable (no used_at on access).

alter table link_tokens
  drop constraint link_tokens_purpose_check;

alter table link_tokens
  add constraint link_tokens_purpose_check
  check (purpose in ('start', 'plan_paste', 'upload', 'calendar'));
