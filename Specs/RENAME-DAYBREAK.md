# Rename to Daybreak — remaining work

Context: product is being renamed from Hammytime to Daybreak. Code identifiers, repo name, Vercel project, Sentry project, Supabase project, and `package.json` all stay as "hammytime." Only user-facing surfaces change. Bot has been renamed in BotFather. `daybreak.run` has been added as an additional domain in Vercel and DNS is propagating.

## Deliverable

Update every user-facing reference to the product name and the canonical URL, and migrate Strava to a fresh app so `daybreak.run` is the canonical OAuth callback host. Do not touch internal identifiers (repo name, Vercel project slug, env var names, Sentry DSN, Supabase project, `package.json` name, code-level "hammytime" symbols).

## Tasks

### 1. Strava — fresh app migration

Decision already made: create a new Strava API app rather than redirect through the old hammytime callback. Existing athletes will have to re-authorize. At current scale (5–25 friends, mostly not yet onboarded) this is acceptable and doubles as a rename announcement.

- [ ] Create a new Strava API application at https://www.strava.com/settings/api with:
  - Application name: `Daybreak`
  - Authorization callback domain: `daybreak.run`
  - Website: `https://daybreak.run`
  - Upload a Daybreak icon
- [ ] Capture the new `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`.
- [ ] Update env in all three Vercel environments (production, preview, development) and `.env.local`. Use `vercel env` commands; remember `vercel env pull` redacts encrypted vars, so verify by reading the Vercel dashboard or doing a runtime probe.
- [ ] Update the OAuth callback URL constant in `src/server/strava/` to point at `https://daybreak.run/api/strava/callback` (verify the exact path against the current route).
- [ ] Re-subscribe the Strava webhook to the new app: `DELETE` the old `push_subscriptions` entry (using old client id/secret), then `POST` a new one with the new credentials and the `daybreak.run` callback URL. The `STRAVA_WEBHOOK_VERIFY_TOKEN` env can stay the same or be rotated — your call.
- [ ] Add a column `athletes.strava_reauth_required boolean default false` (or reuse an existing nullable token column as the signal). Set it `true` for every existing athlete in a single migration. The daily cron should skip athletes with this flag set; the bot should prompt them to reconnect on next interaction; clear the flag on successful reconnect via the new app.
- [ ] When the reconnected athlete completes OAuth, match them back to their existing `athletes` row by `strava_athlete_id` (which is app-independent) and overwrite the token columns. Do not create a duplicate row.
- [ ] Once all athletes have reconnected (or after a cutoff date), delete the old Strava API app.

### 2. Web app — domain and copy

- [ ] Confirm `daybreak.run` resolves and serves the app once DNS is live. Vercel dashboard should show it as "Valid Configuration."
- [ ] Set `daybreak.run` as the primary/canonical domain in Vercel project settings so the previous `hammytime.vercel.app` (and any `hammytime.com` if owned) issues a 308 to `daybreak.run`.
- [ ] Update `NEXT_PUBLIC_APP_URL` to `https://daybreak.run` in Vercel (production + preview + development) and `.env.local`. Audit other base-URL references in `src/server/telegram/` and the prompt template emitter.
- [x] Update user-facing copy on the landing page (`/signup` and root): page `<title>`, H1, hero copy, footer, any "Hammytime" → "Daybreak." *(`/signup` had no product-name copy; root page done.)*
- [x] Update `<meta>` tags: `og:title`, `og:description`, `og:url`, `og:image`, `twitter:*`. *(Set on `app/layout.tsx` metadata; OG image is `/daybreak-icon.png`.)*
- [x] Update `app/layout.tsx` `metadata` export (title, description, metadataBase URL).
- [x] Update favicon / app icons if any are Hammytime-branded. *(Pointed `icons.*` at `/daybreak-icon.png`; old `favicon.ico` still on disk but overridden by metadata.)*
- [x] Update `robots.txt` and `sitemap.xml` if they reference the old host. *(Neither file exists in the project — nothing to do.)*

### 3. Telegram bot — user-facing strings

- [ ] Grep `src/server/telegram/` and the onboarding state machine for "Hammytime" and "hammytime" (case-insensitive) in any string that gets sent to an athlete. Replace with "Daybreak." Leave variable names, file names, comments, and code-level identifiers alone.
- [ ] Update the prompt template the bot sends athletes (the one they paste into Claude/ChatGPT to generate a plan). Wherever the template introduces the product or refers to "Hammytime," change to "Daybreak."
- [ ] Update the onboarding welcome message and any first-message copy.
- [ ] Update help text, command descriptions (mirror these in BotFather `/setcommands` if the descriptions changed).
- [ ] Update error strings that mention the product by name.
- [ ] If any bot message links to the web app, make sure the link is `https://daybreak.run/...` not the old host.

### 4. BotFather — finish what's started

- [ ] `/setdescription` — long description shown on the bot's profile.
- [ ] `/setabouttext` — short tagline shown above the description.
- [ ] `/setuserpic` — Daybreak avatar.
- [ ] `/setcommands` — refresh if any command descriptions referenced Hammytime.
- [ ] Decide on bot username: keeping the existing `@hammytime_*` username is recommended (5–25 friends already have it in their chat list; changing it breaks existing deeplinks). If you do decide to change it via `/setusername`, audit every place the deeplink appears in the codebase and on the web app.

### 5. Documentation in the repo

- [ ] `README.md` — update the one-line description and any user-facing references. Keep code/setup instructions that say "hammytime" untouched (repo name, package name, etc).
- [ ] `Specs/SPEC.md` — add a note that the user-facing product is "Daybreak" while internal identifiers remain "hammytime." Do not rename throughout the spec; just add the mapping in the project-summary section.
- [ ] `CLAUDE.md` — same: add a one-line note up top mapping "Daybreak (user-facing) ↔ hammytime (code)."
- [ ] `claude-status.md` — record the rename as a completed milestone.

### 6. Verification

- [ ] Visit `https://daybreak.run` in an incognito window. Confirm landing page renders, all copy says "Daybreak," no broken images, OG preview renders correctly (test with a Slack/iMessage paste).
- [ ] Confirm `https://hammytime.vercel.app` (or whatever the old URL was) 308s to `daybreak.run`.
- [ ] Run through a Strava OAuth flow end-to-end with a test athlete: consent screen shows "Daybreak," callback lands on `daybreak.run`, tokens persist, webhook fires on next activity.
- [ ] Send a `/start` to the bot from a fresh Telegram account; verify the entire onboarding conversation uses "Daybreak" and the prompt template the bot emits says "Daybreak."
- [ ] Trigger a daily-cron run for a test athlete and confirm the morning message reads naturally with the new name.

## Out of scope — do not touch

- Repo name, Vercel project slug, Sentry project name/DSN, Supabase project, `package.json` name field.
- Code-level identifiers, file names, directory names, env var names, database table/column names.
- Comments and internal docs that reference "hammytime" as the codebase.
- Any in-code symbol named `hammytime*`.
