-- Google Calendar OAuth direct-write (Specs/CALENDAR_OAUTH.md).
-- The provider='google_calendar' row reuses the Strava token shape; the one
-- extra fact it needs is which calendar we own. The dedicated "Daybreak"
-- secondary calendar is created at connect time and deleted at disconnect,
-- so its id lives and dies with the token row.
alter table oauth_tokens
  add column provider_calendar_id text null;

comment on column oauth_tokens.provider_calendar_id is
  'For provider=google_calendar: id of the dedicated Daybreak secondary calendar this token writes to.';
