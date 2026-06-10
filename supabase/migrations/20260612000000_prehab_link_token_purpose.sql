-- allow 'prehab' as a link_tokens.purpose value
-- Prehab tokens are long-lived (5y) and reusable (no used_at on access), same
-- as 'calendar'. They unlock the public per-athlete prehab routine page at
-- /prehab/<token>.

alter table link_tokens
  drop constraint link_tokens_purpose_check;

alter table link_tokens
  add constraint link_tokens_purpose_check
  check (purpose in ('start', 'plan_paste', 'upload', 'calendar', 'prehab'));
