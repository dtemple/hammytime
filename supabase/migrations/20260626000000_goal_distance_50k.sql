-- Onboarding v4 (V4-W4): admit the 50k ultra bucket into goal_distance (U1 catalog).
--
-- ULTRA_SUPPORT.md U1 grows the catalog one rung past the marathon: a 50k is
-- structurally a long trail marathon and gets a real plan (the ultra-50k template).
-- The goal_distance CHECK in 20260601000000_athlete_training_profile.sql allowed only
-- 5k/10k/half/marathon/keep_fit, so a committed 50k athlete would have been rejected
-- at the row write. Distances beyond the 50k (50mi+) are NOT a bucket — they hit the
-- intake off-ramp and never reach this column. The races.event_kind column (non-race
-- adventures) is a separate migration that lands with W4b.

alter table athlete_training_profile
  drop constraint if exists athlete_training_profile_goal_distance_check;

alter table athlete_training_profile
  add constraint athlete_training_profile_goal_distance_check
  check (goal_distance in ('5k', '10k', 'half', 'marathon', '50k', 'keep_fit'));
