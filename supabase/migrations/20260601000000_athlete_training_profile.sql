-- Onboarding v2 (W2) — structured, queryable training profile.
-- The v2 flow collects experience tier, goal shape, days/week and long-run day as
-- button taps. These need to be queryable by W3's template selector, not regex'd
-- back out of memory markdown — so they land here, 1:1 with athletes.
--
-- Three goal states (see Specs/ONBOARDING_V2.md):
--   committed  — a real race is locked (races row + goal_race_id; target_date = race date)
--   intended   — race wanted but not yet picked (A4b: goal_distance set, target_date is a
--                placeholder of today + chosen timeframe, or null for "no timeline"; no race row)
--   day_to_day — no race at all (A2 day-to-day coach path)
create table athlete_training_profile (
  athlete_id      uuid        primary key references athletes(id) on delete cascade,
  goal_type       text        not null check (goal_type in ('race', 'day_to_day')),
  goal_state      text        not null check (goal_state in ('committed', 'intended', 'day_to_day')),
  experience_tier text        check (experience_tier in ('beginner', 'for_fun', 'some_training', 'experienced')),
  goal_distance   text        check (goal_distance in ('5k', '10k', 'half', 'marathon', 'keep_fit')),
  days_per_week   int         check (days_per_week between 3 and 7),
  long_run_day    int         check (long_run_day between 0 and 6),     -- 0=Sun..6=Sat, matches getFitnessSnapshot
  target_date     date,                                                  -- placeholder for intended, mirror for committed, null for day_to_day / no-timeline
  goal_race_id    uuid        references races(id) on delete set null,   -- set only when goal_state = 'committed'
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table athlete_training_profile enable row level security;
-- No policies (matches the other athlete-scoped tables): athlete reads own row,
-- service role for all writes from the bot. Service-role only in v1.

-- ---------------------------------------------------------------------------
-- Idempotent onboarding-state advance, guarded on the current partial.sub_step.
-- set_onboarding_state writes unconditionally; the Strava callback can fire twice
-- (Strava retries) and a plain read-then-write races even under the advisory lock.
-- A0 seeds onboarding_state with partial.sub_step = 'awaiting_strava'; the Strava
-- callback's resumeAfterStrava advances through this guard with
-- p_expected_substep = 'awaiting_strava'. The second callback finds a different
-- sub_step and no-ops — closing the double-callback window. Returns true if it wrote.
create or replace function set_onboarding_state_if_substep(
  p_athlete_id       uuid,
  p_new_state        jsonb,
  p_expected_substep text
) returns boolean
language plpgsql as $$
declare
  v_current_substep text;
begin
  perform pg_advisory_xact_lock(hashtext('athlete:' || p_athlete_id::text));

  select onboarding_state->'partial'->>'sub_step'
  into v_current_substep
  from athletes
  where id = p_athlete_id;

  if v_current_substep is distinct from p_expected_substep then
    return false;
  end if;

  update athletes
  set onboarding_state = p_new_state,
      updated_at        = now()
  where id = p_athlete_id;

  return true;
end;
$$;
