-- Onboarding v4 (V4-W4b): event_kind on a race row.
--
-- v4 broadened intake from organized races to any dated event. A non-race
-- adventure — a self-set long run, a friend's route, an FKT attempt — now commits
-- a races row from the athlete's own words. event_kind distinguishes the two so
-- the recap (and, later, the race-week coach copy) can say "your run" instead of
-- "your race". Default 'race' keeps every existing row valid; the column drives no
-- plan logic (the bucket still does), so it's safe and cheap.

alter table races
  add column event_kind text not null default 'race'
  check (event_kind in ('race', 'adventure'));

comment on column races.event_kind is
  'V4-W4b: race = organized event; adventure = athlete-stated personal objective with a date.';
