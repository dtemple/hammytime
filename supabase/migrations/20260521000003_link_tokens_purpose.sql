-- v0.4.1: extend link_tokens to support plan_paste (and future upload) purposes
-- plan_paste tokens have no email, so email must become nullable

alter table link_tokens alter column email drop not null;

alter table link_tokens
  add column purpose text not null default 'start'
  check (purpose in ('start', 'plan_paste', 'upload'));

alter table link_tokens
  add column plan_version_id uuid references plan_versions(id) on delete cascade;

-- Purpose + token: fast lookup on the paste-page token validation path
create index link_tokens_purpose_token_idx on link_tokens(purpose, token);

-- Athlete + purpose (unused): fast lookup for bot awaiting_paste reply
create index link_tokens_athlete_purpose_idx on link_tokens(athlete_id, purpose)
  where used_at is null;
