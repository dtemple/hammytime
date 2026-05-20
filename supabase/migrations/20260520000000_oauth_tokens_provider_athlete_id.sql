-- Add provider_athlete_id to oauth_tokens for Strava webhook routing.
-- Strava webhooks arrive with owner_id (numeric athlete id); this column
-- lets us resolve that back to our athlete row without a join through activities.
alter table oauth_tokens
  add column provider_athlete_id text null;

-- Fast lookup for the webhook routing query:
--   SELECT athlete_id FROM oauth_tokens WHERE provider = 'strava' AND provider_athlete_id = $1
create index oauth_tokens_provider_athlete_id_idx
  on oauth_tokens (provider, provider_athlete_id);

-- One Strava athlete maps to at most one row in oauth_tokens.
-- Partial so NULLs (pre-Strava-connect rows) are excluded.
create unique index oauth_tokens_provider_athlete_id_unique
  on oauth_tokens (provider, provider_athlete_id)
  where provider_athlete_id is not null;
