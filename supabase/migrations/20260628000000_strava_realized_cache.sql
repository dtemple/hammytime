-- ---------------------------------------------------------------------------
-- Readiness v2 (Strava-aware) — the realized-series cache. Specs/READINESS_V2.md.
--
-- computeReadiness gains a realized long-run history (what the athlete actually
-- ran, from Strava) so the verdict catches the plan and reality diverging
-- without an edit. That series is a per-week rollup over the whole build, which
-- needs a paginated Strava fetch — too expensive to repeat on every hydrate (an
-- inbound message triggers a run, so a chatty athlete drives many runs/day).
--
-- This table caches the rollup once per athlete per day. hydrate reads the row
-- and recomputes only when computed_date rolls or plan_version_id changes (a
-- plan edit re-buckets). One row per athlete, upserted.
--
-- RLS convention (matches the rest of the schema): enable RLS, no policies. All
-- access is via the service-role key (supabaseAdmin()), which bypasses RLS; the
-- anon/authenticated PostgREST path is denied.
-- ---------------------------------------------------------------------------

create table strava_realized_cache (
  athlete_id      uuid        primary key references athletes(id) on delete cascade,
  plan_version_id uuid        not null,                 -- the working plan version the series was bucketed against
  computed_date   date        not null,                 -- athlete-local date the series was computed for
  series          jsonb       not null,                 -- RealizedWeek[]: { week_number, actualLongRunMi, actualVolumeMi }
  updated_at      timestamptz not null default now()
);

alter table strava_realized_cache enable row level security;
