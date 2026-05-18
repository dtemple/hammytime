-- Initial v0.3 schema
-- Corresponds to SPEC.md §3.3 + link_tokens (needed for /signup flow)
-- RLS is enabled on all athlete-scoped tables; policies are a separate prompt (see TODO block at bottom)

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table users (
  id         uuid        primary key default gen_random_uuid(),
  email      text        not null unique,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- athletes
-- ---------------------------------------------------------------------------
create table athletes (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        references users(id) on delete set null,
  name             text        not null,
  dob              date,
  sex              text,
  asthma           boolean     not null default false,
  timezone         text        not null default 'America/Los_Angeles',
  telegram_chat_id text        unique,
  notes            text,
  onboarding_state jsonb       not null default '{}'::jsonb,
  shadow_bcc_until timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- injuries
-- ---------------------------------------------------------------------------
create table injuries (
  id         uuid        primary key default gen_random_uuid(),
  athlete_id uuid        not null references athletes(id) on delete cascade,
  body_part  text        not null,
  severity   int         check (severity between 1 and 10),
  status     text        not null default 'active'
                         check (status in ('active', 'resolved', 'monitoring')),
  notes      text,
  started_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- races
-- ---------------------------------------------------------------------------
create table races (
  id              uuid        primary key default gen_random_uuid(),
  athlete_id      uuid        not null references athletes(id) on delete cascade,
  name            text        not null,
  date            date,
  distance_mi     numeric,
  elevation_ft    int,
  terrain         text,
  target_type     text        check (target_type in ('finish', 'time')),
  target_time_sec int,
  status          text        not null default 'upcoming',
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- plans  (current_version_id FK added after plan_versions to break the cycle)
-- ---------------------------------------------------------------------------
create table plans (
  id                 uuid        primary key default gen_random_uuid(),
  athlete_id         uuid        not null references athletes(id) on delete cascade,
  goal_race_id       uuid        references races(id) on delete set null,
  start_date         date,
  weeks              int,
  current_version_id uuid,       -- FK constraint added below
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- plan_versions
-- ---------------------------------------------------------------------------
create table plan_versions (
  id            uuid        primary key default gen_random_uuid(),
  plan_id       uuid        not null references plans(id) on delete cascade,
  version       int         not null default 1,
  plan_json     jsonb       not null,
  schema_version int        not null default 1,
  generated_by  text        not null
                            check (generated_by in ('athlete_llm', 'manual', 'claude_v2')),
  status        text        not null
                            check (status in ('awaiting_paste', 'active', 'superseded')),
  generated_at  timestamptz not null default now(),
  supersedes_id uuid        references plan_versions(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Resolve the circular FK now that both tables exist
alter table plans
  add constraint plans_current_version_id_fkey
  foreign key (current_version_id)
  references plan_versions(id)
  on delete set null
  deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- memory_files  (one row per athlete × file_name)
-- ---------------------------------------------------------------------------
create table memory_files (
  id         uuid        primary key default gen_random_uuid(),
  athlete_id uuid        not null references athletes(id) on delete cascade,
  file_name  text        not null,
  content_md text        not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (athlete_id, file_name)
);

-- ---------------------------------------------------------------------------
-- oauth_tokens
-- ---------------------------------------------------------------------------
create table oauth_tokens (
  id                uuid        primary key default gen_random_uuid(),
  athlete_id        uuid        not null references athletes(id) on delete cascade,
  provider          text        not null,
  access_token_enc  text        not null,
  refresh_token_enc text        not null,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (athlete_id, provider)
);

-- ---------------------------------------------------------------------------
-- activities
-- ---------------------------------------------------------------------------
create table activities (
  id           uuid        primary key default gen_random_uuid(),
  athlete_id   uuid        not null references athletes(id) on delete cascade,
  source       text        not null,
  source_id    text        not null,
  start_at     timestamptz not null,
  distance_mi  numeric,
  duration_sec int,
  elevation_ft numeric,
  avg_hr       numeric,
  type         text,
  raw_json     jsonb,
  created_at   timestamptz not null default now(),
  unique (athlete_id, source, source_id)
);

-- ---------------------------------------------------------------------------
-- agent_runs
-- ---------------------------------------------------------------------------
create table agent_runs (
  id             uuid        primary key default gen_random_uuid(),
  athlete_id     uuid        not null references athletes(id) on delete cascade,
  kind           text        not null
                             check (kind in ('daily', 'adhoc', 'weekly', 'plan_validate')),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  model          text,
  input_tokens   int,
  output_tokens  int,
  cost_usd       numeric(10, 6),
  result_summary text,
  error          text,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
create table messages (
  id                uuid        primary key default gen_random_uuid(),
  athlete_id        uuid        not null references athletes(id) on delete cascade,
  channel           text        not null check (channel in ('tg', 'web')),
  direction         text        not null check (direction in ('in', 'out')),
  body              text        not null,
  sent_at           timestamptz not null default now(),
  related_run_id    uuid        references agent_runs(id) on delete set null,
  mirrored_to_admin boolean     not null default false,
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- agent_run_steps
-- ---------------------------------------------------------------------------
create table agent_run_steps (
  id           uuid        primary key default gen_random_uuid(),
  agent_run_id uuid        not null references agent_runs(id) on delete cascade,
  step_n       int         not null,
  kind         text        not null check (kind in ('tool', 'llm')),
  tool_name    text,
  input_json   jsonb,
  output_json  jsonb,
  tokens_in    int,
  tokens_out   int,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- friend_allowlist
-- ---------------------------------------------------------------------------
create table friend_allowlist (
  id         uuid        primary key default gen_random_uuid(),
  email      text        not null unique,
  added_by   text,
  note       text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- job_queue
-- ---------------------------------------------------------------------------
create table job_queue (
  id           uuid        primary key default gen_random_uuid(),
  kind         text        not null,
  key_unique   text        not null unique,
  payload      jsonb       not null,
  run_after    timestamptz not null default now(),
  locked_at    timestamptz,
  attempts     int         not null default 0,
  last_error   text,
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- link_tokens  (minted at /signup; athlete_id backfilled when /start completes)
-- ---------------------------------------------------------------------------
create table link_tokens (
  id         uuid        primary key default gen_random_uuid(),
  email      text        not null,
  athlete_id uuid        references athletes(id) on delete cascade,
  token      text        not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index athletes_telegram_chat_id_idx   on athletes(telegram_chat_id);
create index messages_athlete_sent_at_idx    on messages(athlete_id, sent_at desc);
create index agent_runs_athlete_started_idx  on agent_runs(athlete_id, started_at desc);
create index job_queue_run_after_locked_idx  on job_queue(run_after, locked_at)
  where completed_at is null;
create index link_tokens_token_idx           on link_tokens(token);
create index link_tokens_expires_at_idx      on link_tokens(expires_at);
-- friend_allowlist(email) unique constraint creates an implicit index

-- ---------------------------------------------------------------------------
-- Row-level security — enabled, no policies yet
-- ---------------------------------------------------------------------------
alter table athletes        enable row level security;
alter table injuries        enable row level security;
alter table races           enable row level security;
alter table plans           enable row level security;
alter table plan_versions   enable row level security;
alter table memory_files    enable row level security;
alter table oauth_tokens    enable row level security;
alter table activities      enable row level security;
alter table messages        enable row level security;
alter table agent_runs      enable row level security;
alter table agent_run_steps enable row level security;

-- TODO: write RLS policies for the following tables (separate prompt):
--
--   athletes        — athlete reads/updates own row (cookie-derived athlete_id);
--                     service role for all writes from the bot/agent
--   injuries        — athlete reads own rows; service role writes
--   races           — athlete reads own rows; service role writes
--   plans           — athlete reads own rows; service role writes
--   plan_versions   — athlete reads own rows; service role writes
--   memory_files    — athlete reads own rows; service role writes (never expose to client directly)
--   oauth_tokens    — service role only; never expose raw tokens to client
--   activities      — athlete reads own rows; service role writes
--   messages        — athlete reads own rows; service role writes
--   agent_runs      — athlete reads own rows; service role writes
--   agent_run_steps — athlete reads own rows via agent_run_id; service role writes
--
-- Admin (David) accesses all tables via the service-role key in the /admin console.
-- Non-athlete-scoped tables (users, friend_allowlist, job_queue, link_tokens)
-- are accessed only by the service role; no per-row policies needed.
