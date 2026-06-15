-- Auto-pause on inactivity (METERING_PAYMENTS.md §10.5)
-- Introduces the pause primitive: the daily enqueue cron skips any athlete with
-- a non-null paused_at, and an inactive athlete (>10 days of silence) is paused
-- automatically. pause_reason distinguishes the auto pause (resumes on any
-- inbound) from a future manual /pause (§10, vacation — does NOT resume on
-- inbound). pause_resumes_at is a §10 concern (timed manual pause) and is added
-- when that lands.

alter table athletes
  add column paused_at    timestamptz,   -- null = active
  add column pause_reason text;          -- 'auto_inactivity' | 'manual', null when active
