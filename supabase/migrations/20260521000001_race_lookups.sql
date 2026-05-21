-- Race lookup cache: stores Anthropic web-search results per normalized race name.
-- name_lower is the cache key: lowercased, year-stripped, whitespace-collapsed.
-- 30-day TTL enforced in application logic via expires_at.
CREATE TABLE race_lookups (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name_lower text        UNIQUE NOT NULL,
  result     jsonb       NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON race_lookups (expires_at);
