# V4-W3 — Post-event pause (next implementation step)

_Paste this into a fresh session. It is self-contained; it assumes no memory of
the session that built V4-W2._

## What you're building

**V4-W3: the post-event pause** (`Specs/ONBOARDING_V4.md` §4.4 + §4.5, workstream
in §10). When a committed event is behind the athlete and their plan's dated days
are exhausted, the athlete enters the **dormant state** instead of getting a
rolling maintenance plan: daily check-ins stop, ad-hoc Q&A still works, and naming
a new event resumes everything. This is the **second door** into the dormant state
that V4-W2 already built (the first door is the entry off-ramp).

## Read first (source of truth)

1. **`Specs/ONBOARDING_V4.md`** — the signed-off v4 spec. Read §4.4 (the post-event
   pause), §4.5 (the dormant state — "one state, two doors"), and the W3 line in
   §10. Note Decision 5: post-event = **pause, not maintenance**; the pause is
   **passive** (no scheduled nudge, unlike the entry off-ramp's check-back).
2. **`Specs/CHANGELOG.md` v0.7.40** — the authoritative record of what V4-W2 built
   (the dormant primitive you will reuse). Read it before touching `pause.ts`.
3. **`CLAUDE.md`** — §2 (source-of-truth rule), §9 (working agreement — each prompt
   is a scoped unit; confirm before expanding), §10 (git/deploy discipline).

## What V4-W2 already built — REUSE, don't reinvent

The dormant state and its helpers exist. W3 is the second caller.

- **`src/server/telegram/pause.ts`** — the dormant primitive:
  - `enterDormant(athleteId, checkBackAt)` — sets `paused_at` + `pause_reason='dormant'`
    + `check_back_at`. **W3 calls `enterDormant(athleteId, null)`** (the pause is
    passive — no check-back nudge).
  - `exitDormant(athleteId)` — clears the dormant pause (scoped to
    `pause_reason='dormant'`, so it won't touch an auto_inactivity/manual pause).
    Returns whether it cleared. **This is your re-activation primitive.**
  - `sendAndLogOutbound(chatId, athleteId, body, keyboard?)` — sends one static bot
    message and logs it to `messages`. **Use this for the post-event pause notice.**
  - `CHECK_BACK_NUDGE` / `sweepCheckBacks` / `setCheckBack` are off-ramp-only; W3
    does NOT use them (passive pause).
- **The daily cron already skips dormant athletes for free** — `src/app/api/cron/daily-checkin/route.ts`
  filters `if (a.paused_at != null) return false`. So once a post-event athlete is
  dormant, the daily run stops with no further change.
- **Q&A-stays-open is mostly free for this door.** A post-event athlete is
  `phase: 'complete'` with a (finished) plan, so `src/server/telegram/bot.ts` already
  routes their inbound to the coach (it gates on having a plan, not on `paused_at`;
  and `clearAutoInactivityPause` ignores `pause_reason='dormant'`, so an inbound
  won't wrongly wake them). **Verify this end to end** rather than assuming it.
- The off-ramp's `off_ramp` phase + `off_ramp_offered` flag (`slots/slot-state.ts`)
  are the **entry-off-ramp door** — a post-event athlete stays `phase: 'complete'`,
  so they are NOT in that path. Keep the two doors distinct.

## The genuinely new work (and where it's tricky)

Two pieces are net-new. Before building, settle the two design questions below with
David — they're left open in the spec on purpose.

### 1. Detecting event-complete → enter the pause

When does a committed athlete become post-event? The signal is: the committed
event's date has passed and the plan's dated days are exhausted. Candidate signals:
`races.date` (or `athlete_training_profile.target_date`) is in the past, and/or the
plan has no future dated days. The natural place to detect-and-act is the daily
cron (`daily-checkin/route.ts`), alongside the existing inactivity scan: before
enqueuing a due athlete, if they're event-complete, call `enterDormant(id, null)`,
send the static pause notice via `sendAndLogOutbound`, and skip the enqueue — the
same shape as the inactivity auto-pause already in that file. **Confirm with David:**
the exact "exhausted" definition (race date passed vs. last dated day passed), and
whether detection lives in the cron or elsewhere.

The pause notice is hand-written (draft in §4.4 — David wordsmiths; mark it DRAFT,
follow `CLAUDE.md` §3's no-AI-tells copy rules).

### 2. Re-activation — a post-event athlete naming a new event

This is the hard part and the spec leaves the mechanism open (§4.5: "commit an
event → plan renders → dailies resume"). For the **off-ramp door** this is free
(that athlete sits at `phase: 'off_ramp'`, so `bot.ts` routes them to the onboarding
engine, which already commits a race + plan and calls `exitDormant`). For the
**post-event door** it is NOT free: a `phase: 'complete'` athlete's inbound goes to
the **coach** (the worker), which today just chats — it doesn't create a `races`
row, render a plan, or call `exitDormant`. So a "I signed up for CIM" message would
get a friendly reply and nothing would actually re-activate (a silent dead-end).

**Settle with David which path re-activates a post-event athlete:**
- (a) `/edit_profile` / a "set my next event" flow that re-enters the onboarding
  engine's commit path (reuses W2's `exitDormant` + the existing plan-gen), or
- (b) the worker coach gains the ability to detect a committed new event and trigger
  a re-plan + `exitDormant` (a worker change → would need `fly deploy`), or
- (c) ship the pause half now and defer re-activation as a fast-follow.

**Recommended:** consider splitting W3 — **W3a** (detect event-complete → enter
pause + verify Q&A-stays-open; high value, low risk, web/cron only) and **W3b**
(re-activation). W3a is the clean scoped unit; W3b needs the design decision above.
Propose the split to David rather than building the whole thing on an unconfirmed
re-activation design.

## Constraints / gotchas

- **No new migration needed.** The dormant state reuses `pause_reason='dormant'`
  (free-text column) and `athletes.check_back_at` (already on prod). W3's passive
  pause uses neither beyond `enterDormant(id, null)`.
- **Deploy surface:** W3a (cron + pause.ts) is **web-only — push to Vercel, NO
  `fly deploy`**. If W3b touches the worker coach, that half needs `fly deploy`
  (`CLAUDE.md` §10). Match the deploy to what changed.
- **`pause.ts` may be under concurrent edit.** As of v0.7.40 another workstream was
  adding manual `/pause` + `/resume` (`pauseAthleteManual` / `resumeAthlete`) to
  `pause.ts` / `bot.ts` / `commands.ts`. Run `git status` first; if those land, your
  dormant calls sit alongside them — coordinate, don't clobber (`CLAUDE.md` §10).
- **Don't reopen anti-goals** (`CLAUDE.md` §5): no Inngest, no manual-log fallback.
  The passive pause has no nudge, so no new cron/job machinery.
- **Verify, don't assume:** confirm in `bot.ts` that a `phase:'complete'` +
  `pause_reason='dormant'` athlete's inbound actually reaches the coach (not the
  `!plan` dead-end, not a wrongful wake). Add a test if there's a gap.

## Definition of done

- Event-complete athletes enter the dormant state (no maintenance plan); the daily
  cron stops enqueuing them; the static pause notice fires once.
- Q&A stays open for the paused athlete (verified end to end).
- Re-activation works per the path chosen with David (or is explicitly deferred as
  W3b with a written note).
- Tests for the new detection + pause-entry (and re-activation if in scope);
  `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` all green.
- Commit + push; apply the deploy surface that matches the change. Update
  `Specs/CHANGELOG.md` (next version), `Specs/ONBOARDING_V4.md` (§10 W3 status), and
  `claude-status.md` per the §8 convention.

## After W3

Remaining v4 (unscheduled): **W4** (ULTRA U1 catalog + `event_kind` + athlete-stated
adventure fill — also unblocks W1's deferred recap/adventure-fill half), **W5** (web
positioning copy — David wordsmiths), **W6** (eval harness — the launch gate before
opening to more users). U2 (50mi+ renderer work) is deferred (§6).
