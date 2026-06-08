-- Diagnose the "3 Santa Rosa dates" bug for a single athlete.
-- Read-only. Run in the Supabase SQL editor (prod) against Brenden's athlete_id.
--
-- What we're testing:
--   H1  /restart left stale plan_versions / races behind (duplicate-version theory)
--   H2  the renderer placed race day before the real race date (confirmed in code:
--       startDate=today, totalWeeks=floor(weeks_between), race day on the long-run
--       weekday of the last week — never anchored to the actual race date)
--
-- Adjust the UUID below if you re-run for a different athlete.

with a as (
  select 'fde65f1e-7ba4-4816-8052-f6e0ebc27528'::uuid as athlete_id
)

-- 1. Every race row for the athlete. >1 row ⇒ the non-idempotent insert in
--    commitGoal duplicated (or a prior onboarding wasn't cleared). All rows
--    SHOULD carry the looked-up date (Aug 23); duplicates do not by themselves
--    explain the Aug 8 / Aug 15 markers (those are the renderer).
select 'races' as source, r.id::text as ref, r.name,
       r.date::text as a_date, r.status, r.created_at
from races r, a
where r.athlete_id = a.athlete_id
order by r.created_at;

-- RESULTS: [
  {
    "source": "races",
    "ref": "c5549e99-966a-48df-bc0b-3af5e7e0d0c3",
    "name": "Santa Rosa Marathon",
    "a_date": "2026-08-23",
    "status": "upcoming",
    "created_at": "2026-06-07 14:41:37.123088+00"
  }
]


-- 2. Plans + their start_date / weeks / active version pointer.
select 'plans' as source, p.id::text as ref, p.goal_race_id::text as name,
       p.start_date::text as a_date, p.weeks::text as status, p.created_at
from plans p, a
where p.athlete_id = a.athlete_id
order by p.created_at;

-- RESULTS:
[
  {
    "source": "plans",
    "ref": "feba34c9-5693-44bb-9e9a-ea6224fae2ac",
    "name": "c5549e99-966a-48df-bc0b-3af5e7e0d0c3",
    "a_date": "2026-06-01",
    "status": "11",
    "created_at": "2026-06-07 14:41:39.9612+00"
  }
]

-- 3. Plan versions: status, who generated, the race date stored in metadata, and
--    the ACTUAL rendered race-day date(s) pulled out of plan_json. This is the
--    smoking gun: compare `metadata_race_date` (should be Aug 23) against
--    `rendered_race_day` (the buggy Aug 8 / Aug 15). Multiple active/superseded
--    versions here = the duplicate-marker source.
select 'plan_versions' as source,
       pv.id::text as ref,
       pv.generated_by || ' v' || pv.version || ' (' || pv.status || ')' as name,
       (pv.plan_json #>> '{metadata,race,date}') as metadata_race_date,
       d.rendered_race_day,
       pv.generated_at
from plan_versions pv
join plans p on p.id = pv.plan_id
cross join a
left join lateral (
  select (day ->> 'date') as rendered_race_day
  from jsonb_array_elements(pv.plan_json -> 'weeks') as wk
  cross join jsonb_array_elements(wk -> 'days') as day
  where (day ->> 'type') = 'race'
) d on true
where p.athlete_id = a.athlete_id
order by pv.generated_at;

-- RESEULTS:

[
  {
    "source": "plan_versions",
    "ref": "37a17fca-2b58-48e0-8345-b41e9177df78",
    "name": "template v1 (active)",
    "metadata_race_date": "2026-08-23",
    "rendered_race_day": "2026-08-08",
    "generated_at": "2026-06-07 14:41:40.059817+00"
  },
  {
    "source": "plan_versions",
    "ref": "37a17fca-2b58-48e0-8345-b41e9177df78",
    "name": "template v1 (active)",
    "metadata_race_date": "2026-08-23",
    "rendered_race_day": "2026-08-15",
    "generated_at": "2026-06-07 14:41:40.059817+00"
  }
]

-- 4. What the training profile points at (target_date + goal_race_id) — confirms
--    which race row is authoritative and whether target_date matches the race row.
select 'training_profile' as source,
       tp.goal_race_id::text as ref,
       tp.goal_state as name,
       tp.target_date::text as a_date
from athlete_training_profile tp, a
where tp.athlete_id = a.athlete_id;

-- RESULTS:
[
  {
    "source": "training_profile",
    "ref": "c5549e99-966a-48df-bc0b-3af5e7e0d0c3",
    "name": "committed",
    "a_date": "2026-08-23"
  }
]