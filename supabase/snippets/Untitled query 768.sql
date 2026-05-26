select id, plan_id, version, schema_version, generated_by, status,
       jsonb_typeof(plan_json) as json_type,
       jsonb_array_length(plan_json->'weeks') as week_count
from plan_versions
where plan_id in (
  select id from plans where athlete_id = (
    select a.id from athletes a join users u on u.id = a.user_id
    where u.email = 'dtemple@gmail.com'
  )
);