-- Onboarding v4 (V4-W2): the dormant athlete state.
--
-- v4 stops shipping a keep_fit plan to a no-event signup. Instead the athlete is
-- off-ramped into a dormant state — row intact, Strava connected, no plan, the
-- daily cron skipping them — and asked when to check back. The dormant state
-- reuses the existing pause primitive (paused_at / pause_reason): a new
-- pause_reason value 'dormant' marks an off-ramped (or, later, a post-event)
-- athlete. pause_reason is free text (no CHECK), so 'dormant' needs no constraint
-- change; it stays distinct from 'auto_inactivity' so clearAutoInactivityPause
-- won't wake a dormant athlete on a stray inbound — only naming an event does.
--
-- check_back_at is the one-shot nudge date: the off-ramped athlete picked an
-- interval (1 / 3 / 6 months), and the daily cron fires a single static nudge at
-- that date, then nulls it. Null = no scheduled nudge (the "don't bother" path).

alter table athletes
  add column check_back_at timestamptz;   -- one-shot off-ramp nudge date; null = none

comment on column athletes.check_back_at is
  'Onboarding v4 off-ramp: date of the single scheduled check-back nudge; nulled after it fires. Null = no nudge.';
