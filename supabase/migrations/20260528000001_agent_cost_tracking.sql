-- Per-athlete token/cost tracking (precursor to the prepaid feature, SPEC §3.11).
-- We are NOT building the prepaid balance yet (<20 users). This migration only
-- makes the cost data we already record queryable, and stops dropping the
-- cache-token breakdown — the biggest lever for pricing the feature later.

-- 1. Capture the cache-token split. The Anthropic usage object reports cached
--    input separately from fresh input; once we prompt-cache the system prompt
--    and memory files, cache reads (≈10× cheaper) will dominate input volume.
--    Without these columns, summed tokens won't reconcile with cost_usd.
alter table agent_runs
  add column cache_creation_input_tokens int,
  add column cache_read_input_tokens     int;

-- 2. Fix the agent_run_steps kind constraint. The worker records one step per
--    tool call as 'tool_use' / 'tool_result' (worker/persist.ts), but the
--    original CHECK only allowed 'tool' / 'llm', so every step insert failed
--    silently. Nothing writes the old values, so realign the constraint.
alter table agent_run_steps drop constraint agent_run_steps_kind_check;
alter table agent_run_steps
  add constraint agent_run_steps_kind_check
  check (kind in ('tool_use', 'tool_result'));

-- 3. Daily rollup, bucketed by the athlete's local calendar day (a late-evening
--    run shouldn't land on the wrong day). One row per athlete per active day.
create view athlete_cost_daily
  with (security_invoker = true)
  as
select
  r.athlete_id,
  (r.started_at at time zone a.timezone)::date            as local_day,
  count(*)                                                as runs,
  sum(coalesce(r.input_tokens, 0))                        as input_tokens,
  sum(coalesce(r.output_tokens, 0))                       as output_tokens,
  sum(coalesce(r.cache_creation_input_tokens, 0))         as cache_creation_input_tokens,
  sum(coalesce(r.cache_read_input_tokens, 0))             as cache_read_input_tokens,
  sum(coalesce(r.cost_usd, 0))                            as cost_usd
from agent_runs r
join athletes a on a.id = r.athlete_id
group by r.athlete_id, local_day;

-- 4. Cumulative rollup with trailing 7d / 28d windows for a quick read on
--    recent burn vs. lifetime spend per athlete.
create view athlete_cost_rollup
  with (security_invoker = true)
  as
select
  r.athlete_id,
  count(*)                                                as total_runs,
  min(r.started_at)                                       as first_run_at,
  max(r.started_at)                                       as last_run_at,
  sum(coalesce(r.input_tokens, 0))                        as input_tokens,
  sum(coalesce(r.output_tokens, 0))                       as output_tokens,
  sum(coalesce(r.cache_creation_input_tokens, 0))         as cache_creation_input_tokens,
  sum(coalesce(r.cache_read_input_tokens, 0))             as cache_read_input_tokens,
  sum(coalesce(r.cost_usd, 0))                            as cost_usd,
  count(*) filter (where r.started_at >= now() - interval '7 days')           as runs_7d,
  sum(coalesce(r.cost_usd, 0)) filter (where r.started_at >= now() - interval '7 days')  as cost_usd_7d,
  count(*) filter (where r.started_at >= now() - interval '28 days')          as runs_28d,
  sum(coalesce(r.cost_usd, 0)) filter (where r.started_at >= now() - interval '28 days') as cost_usd_28d
from agent_runs r
group by r.athlete_id;
