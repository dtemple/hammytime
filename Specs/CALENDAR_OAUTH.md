# Calendar-OAuth — Google direct-write, ICS retained for Apple & everyone else

> Design record for the OAuth calendar-write feature (drafted 2026-06-09). Source of truth until folded into a §3.x of `SPEC.md`. A `Specs/CHANGELOG.md` entry should point here (§2 governance). Companion to `Specs/CALENDAR_CONFIRM.md` — that doc owns *what* changes the plan; this doc owns *how the change reaches a calendar app*.

## Why

The subscribed ICS feed (`/api/calendar/{token}.ics`) has one unfixable weakness: **Google Calendar ignores the feed's TTL and polls external `.ics` URLs on its own schedule** (commonly several hours up to ~24h), with no user-facing control. A correct, promptly-persisted plan change can still take a day to appear for a Google user. The ICS *subscribe* UX is also worst on Google — "add by URL" is web-only, so a mobile user has to leave the app and find the URL on desktop.

Neither weakness is universal — both are essentially **Google-specific** (see the provider split below). So the fix is targeted: a Google OAuth direct-write path for Google users, while the ICS feed stays exactly as-is for everyone else.

This is the "B" half of the calendar problem (sync latency). The "A" half (the plan actually changing) is `CALENDAR_CONFIRM.md` and is independent.

## The provider split (core decision)

Direct calendar write is inherently per-provider — there is no universal write API. So match each provider to its best integration:

| Provider | Integration | Latency | Subscribe UX | Verdict |
|---|---|---|---|---|
| **Google** | OAuth direct-write (`calendar.app.created`) | real-time | n/a — calendar just appears | **new path** |
| **Apple / iCloud** | ICS subscription (existing feed) | user-set, down to 5 min | one-tap `webcal://` | **keep as-is** |
| **Outlook / other** | ICS subscription (existing feed) | client-dependent | add-by-URL | **keep as-is** |
| Google (no OAuth) | ICS subscription (fallback) | slow (Google polls) | poor | fallback |

The ICS feed is the **universal baseline** and stays. OAuth Google direct-write is an **enhancement for the one platform where the baseline is weak**. This is principled, not a compromise: on Apple the ICS feed is already near-real-time and easy to subscribe (see "Apple" below), so Apple users don't need OAuth at all.

### Apple Calendar — answered explicitly

OAuth does **not** let us direct-write Apple, and we should not try:

- iCloud has **no REST API and no OAuth** — CalDAV only, authenticated with an **app-specific password the user generates manually** at appleid.apple.com (cannot be issued programmatically, requires 2FA). That means storing iCloud credentials and a miserable connect flow. Non-starter for v1.
- We don't need it. Apple Calendar honors a **user-chosen refresh interval set at subscribe time — 5 min / 15 min / hourly / daily / weekly** — so the existing ICS feed is effectively real-time on Apple, and `webcal://` links open the subscribe sheet in one tap. The ICS feed's weaknesses are Google's, not Apple's.

So: **Apple stays fully supported via the ICS feed it already uses, and is arguably better served by it than by anything OAuth could offer.**

## Scope decisions

- **Scope: `calendar.app.created` only.** Creates and manages a dedicated "Daybreak" secondary calendar; cannot read or touch the user's other calendars. Blast radius = one calendar; disconnect = delete that calendar. **Verify the classification before building** (David's flag — Google reshuffles tiers). It is expected to be **sensitive**, not restricted. The restricted tier (`calendar` / `calendar.events`) triggers a third-party CASA security assessment (multi-week, recurring, possibly paid) and is to be avoided. Gate the build on confirming, on the OAuth consent-screen scope picker, that `calendar.app.created` shows the *sensitive* indicator and not the *restricted* one. If Google has reclassified it restricted, stop and reconsider (ICS-only for Google, or accept CASA).
- **Publish to Production, not Testing.** In Testing status, refresh tokens for sensitive scopes **expire after 7 days**, which kills a background writer (weekly re-consent). Publishing to Production requires one-time verification (sensitive-tier brand/scope review — lighter than restricted CASA).
- **Dedicated per-athlete "Daybreak" calendar.** Create one on connect; write only there; never the primary.
- **Keep the ICS feed.** Apple/Outlook/other + Google-no-OAuth fallback. No change to the render path.

## Write & reconcile design

- **Event identity = the existing UID.** Reuse `{planId}-w{week}-d{day}@hammytime` as the Google `iCalUID`. No separate `plan_day → google_event_id` mapping table — the UID is the join key, stored in Google.
- **Shared day→event mapping.** Refactor the per-day event construction out of `src/lib/calendar-render.ts` (`renderPlanIcs`) into a shared module so the ICS feed and the Google writer emit **byte-for-byte the same event set** (same summary, description, dates, UID). Divergence between the two paths is the main correctness risk; one source removes it.
- **Reconcile on active-plan change.** Whenever `current_version_id` changes — onboarding plan-gen, a promoted proposal (`promote_proposed_version`, per `CALENDAR_CONFIRM.md`), or any future direct edit — recompute the plan's event set and reconcile it against the athlete's Daybreak calendar:
  - For each current UID: `events.list?iCalUID=…` → if absent, `events.import` with that `iCalUID`; if present and changed, `events.update`/`patch`; if unchanged, skip.
  - For UIDs on the calendar no longer in the plan: `events.delete`.
  - Note: `events.import` is *not* a single-call upsert — it requires the `iCalUID` and creates; the list-then-import/update/delete loop is what gives idempotent convergence. Safe to re-run wholesale.
- **Batch the ~154 events** (Calendar batch endpoint / throttle) to stay under per-minute quota.
- **Periodic full reconcile** (nightly, cheap, self-healing) as a safety net against missed events and out-of-band edits, in addition to the event-driven trigger.

## Auth & lifecycle

- **Connect flow** reuses the Strava-in-Telegram → web-callback shape: the bot sends a "Connect Google Calendar" link → web OAuth (`calendar.app.created`, `access_type=offline`, `prompt=consent`) → callback creates the Daybreak calendar, does a first full reconcile, stores the encrypted refresh token. Identity stays `telegram_chat_id ↔ athlete_id` (no Google identity for auth — consistent with the no-Supabase-Auth lock).
- **Token storage/refresh** reuses the Strava token pattern (encrypted at rest; refresh job on a cron; lazy refresh on use). New rows in `oauth_tokens` with `provider='google_calendar'` (or a dedicated table — match the Strava shape).
- **Disconnect / revocation.** Disconnect = delete the Daybreak calendar + drop the token (clean, total removal). Detect a revoked/expired-beyond-refresh token, surface it to the athlete, and fall back to offering the ICS link.

## Trigger plumbing

- Promotion happens in the Vercel callback handler; onboarding plan-gen in the bot path. Don't do Google I/O inline in either request. Instead **enqueue a `calendar_sync` job** (existing `job_queue`) on any active-plan change for a Google-connected athlete; the worker drains it and runs the reconcile (it already has the plan + can batch + can retry). One new job kind, no new infra.

## Honest cost

- **New build:** OAuth plumbing (Strava-shaped, familiar), the reconcile loop (list/import/update/delete + batching + partial-failure handling), the `calendar-render` refactor to share the mapping, the `calendar_sync` job, connect/disconnect UX in the bot, and a one-time Google verification.
- **Maintained surface:** two calendar paths — but the ICS path is stateless, already built, and unchanged. The only *new* moving part is the Google writer. This is not "build two from scratch."
- **Not carried:** the mapping table (UID does that job), and any Apple integration.

## Out of scope

- **Apple/iCloud direct-write** — rejected (CalDAV + manual app-specific password; ICS serves Apple better anyway).
- **Outlook direct-write** — possible later via Microsoft Graph OAuth; ICS covers it for now.
- **Richer event content** (reminders/notifications/colors now that we own the calendar) — defer; match ICS output first.
- The `CALENDAR_CONFIRM.md` propose/promote model — unchanged; this consumes its promotion event.

## Open questions — resolved (build session 2026-06-09, CHANGELOG v0.7.30)

- **Confirm `calendar.app.created` is sensitive (not restricted)** on the live consent screen — **resolved 2026-06-09, better than expected: the scope picker shows it as *non-sensitive*** (David, live console check during Part 0). That means no scope verification at all, no unverified-app warning screen, and no 100-user cap — verification drops out of the plan entirely. Publishing to **Production** still matters: the 7-day refresh-token expiry is tied to Testing publishing status, not scope tier.
- **Routing at "add to calendar"** — **decided: present both.** `/calendar` (and the onboarding next-action) sends a "Connect Google Calendar" button plus the ICS subscribe link; no platform detection.
- **Existing Google ICS subscribers** — **decided: opt-in.** A working subscription is never broken; connecting via `/calendar` is the migration.
- **Reconcile trigger** — **decided: both.** Event-driven `calendar_sync` on promotion / plan-gen / strength-zero, plus a nightly full reconcile (2am PT) as the self-healing net.
- **Verification lead time** — Part 0 is sequenced first; the unverified-production warning screen (100-user cap) covers dogfooding while the sensitive-tier review runs.

Two build-time refinements over the sketch above: the reconcile reads the **whole calendar in one paginated list** and diffs locally by `iCalUID` (the per-UID `events.list` loop in §"Write & reconcile design" cost ~154 GETs for nothing — we own every event on the calendar), and writes are **throttled sequential** rather than the batch endpoint (batched sub-requests count individually against quota, and multipart/mixed parsing with plain fetch is a parser we'd own forever). One Strava-pattern divergence, pinned by test: Google refresh responses carry no new refresh_token — the stored one must be preserved.

## Build sequence (sketch)

1. Confirm scope tier; set up the Google Cloud project, consent screen (Production), `calendar.app.created`, start verification.
2. Refactor `calendar-render.ts` to expose a shared plan→events mapping; ICS feed switches to it (no behavior change; pure refactor + snapshot tests).
3. OAuth connect/callback + token storage/refresh (Strava-shaped); create the Daybreak calendar on connect.
4. Reconcile function (list/import/update/delete + batch + partial-failure) over the shared mapping; first-reconcile on connect.
5. `calendar_sync` job + triggers on active-plan change (onboarding, promotion).
6. Disconnect/revocation; bot connect/disconnect UX; ICS fallback messaging.
7. Nightly full-reconcile safety net.

Tests at each step: render-mapping parity (ICS vs Google event set); reconcile convergence + idempotency on re-run; token refresh/revocation; job trigger on promotion. Web/bot changes → `git push`; worker changes → `git push` + `fly deploy`. Clean-tree check before deploy (§10).
