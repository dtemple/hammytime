# V4-W3b — Post-event re-activation (next implementation step)

_Paste this into a fresh session. It is self-contained; it assumes no memory of
the session that built V4-W3a._

## What you're building

**V4-W3b: re-activation of a post-event athlete** (`Specs/ONBOARDING_V4.md` §4.4–§4.5,
the W3 line in §10). V4-W3a shipped the *pause*: a committed athlete whose event is
behind them goes **dormant** (daily check-ins stop, ad-hoc Q&A stays open). W3b closes
the loop: when that dormant athlete names their **next** event, commit a new race +
plan and wake them. Today this is a **silent dead-end** — their "I signed up for CIM"
message reaches the coach (the worker just chats); nothing creates a `races` row,
generates a plan, or clears the dormant pause.

**The agreed mechanism (decided with David):** a command — a new `/next_event` (or an
`/edit_profile` branch) — that resets a `phase:'complete'` athlete back to **event-scoped
intake**, so the v3 engine's existing `finishOnboarding` does `exitDormant` + commit a
new race + generate a fresh plan. Reuse that path; do not build a parallel one. **Web-only
— push to Vercel, NO `fly deploy`** (no worker change), **no migration**.

## Read first (source of truth)

1. **`Specs/ONBOARDING_V4.md`** — §4.4 (post-event pause), §4.5 ("one state, two doors":
   exited one way — commit an event → plan renders → dailies resume). §10 W3 line.
2. **`Specs/CHANGELOG.md` v0.7.42** (W3a — the pause) and **v0.7.40** (W2 — the dormant
   primitive). These are the authoritative record of what you're building on.
3. **`CLAUDE.md`** — §2 (source-of-truth), §9 (working agreement — scoped unit, confirm
   before expanding), §10 (git/deploy discipline; **run `git status` first — sessions
   collide on `pause.ts`/`bot.ts`/the onboarding engine; W3a hit two collisions**).

## What's already built — REUSE, don't reinvent

- **`exitDormant(athleteId)`** (`src/server/telegram/pause.ts`) — clears the dormant pause,
  scoped to `pause_reason='dormant'` so it never touches a manual/inactivity pause.
  Returns whether it cleared. **`finishOnboarding` already calls this** on the
  event-completion path (router.ts ~line 674), so routing a post-event athlete through it
  wakes them for free.
- **`finishOnboarding`** (`src/server/telegram/onboarding/engine/router.ts` ~649–758) — the
  completion path: `exitDormant` → (if `!state.committed`) `commitSlotsSafe` →
  `generateAndPersistPlan` → set `phase:'complete'`. **This is the path to re-enter.**
- **The engine re-entry gate** (`bot.ts` ~214–218): an inbound routes to `handleV3Message`
  when `ob.phase !== 'complete' || ob.edit_mode`. So flipping a complete athlete's phase
  back to `intake` is what re-opens the engine for their next turns.
- **The off-ramp's intake reset** (router.ts ~662–664) is precedent: it sets
  `phase:'intake'` and keeps the slots. Read it — your reset is the same move plus clearing
  the event slots + the `committed` flag.
- **Command registration** (`bot.ts` ~1264, `commands.ts` `BOT_COMMANDS`): `/edit_profile`
  and `/adjust_plan` show the pattern for a new `/next_event` (handler + menu entry +
  `npm run commands:register` to push `setMyCommands`).

## The genuinely new work — and the load-bearing risks

Re-running the onboarding engine on an athlete who **already has a race + plan** is not
clean. Three things break or leave stale state; settle the design with David first.

### 1. CRITICAL — `generateAndPersistPlan` is idempotent and will return the STALE plan

`generateAndPersistPlan` (`src/server/telegram/onboarding/plan-gen.ts` ~166–191) calls
`getActiveTemplatePlan` first and, **if an active template plan already exists, returns it
unchanged — no new plan**. A post-event athlete still has their finished plan as the active
version, so re-running `finishOnboarding` would commit the new race but hand back the **old
plan** (old dates, old distance). **W3b must retire/supersede the old plan (or bypass the
idempotency gate) so a fresh plan generates for the new event.** This is the core of the
task — confirm with David how: supersede the old `plan_versions` row, or a `regen`-style
path that forces a new plan. Check whether an existing helper (e.g. the `/regen`/plan
regeneration or `record_plan_extension` machinery) already supersedes cleanly before adding
one.

### 2. The `committed` flag guard skips the commit

`finishOnboarding` only commits slots when `!state.committed` (router.ts ~681). A complete
athlete has `committed: true`, so commit is **skipped** unless your reset clears it. The
reset must clear `committed` **and** the event slots (`goal_race`, `goal_date`,
`goal_distance`, `target_time`, `goal_type/goal_state`) while **keeping** the durable facts
(`experience_tier`, `days_per_week`, `long_run_day`, `timezone`) so re-intake is short. Slot
shape: `src/server/telegram/onboarding/slots/slot-state.ts`.

### 3. Stale rows on commit

`commitGoal` (`engine/commit.ts` ~189–212) **inserts a new `races` row** and never touches
the old one — the finished race stays `status='upcoming'`. `athlete_training_profile`
(athlete_id PK) is upserted, so its `goal_race_id` moves to the new race, orphaning the old
row. Decide with David: mark the old race `status='completed'` (cleaner race-calendar view),
or leave it (harmless to dailies). Calendar: `generateAndPersistPlan` already calls
`enqueueCalendarSyncIfConnected`, so a connected athlete re-syncs **if** the new plan
actually becomes active (depends on fixing #1) — verify the old race's events don't linger.

## Settle with David before building

- **Trigger surface:** dedicated `/next_event` command (clearest) vs an `/edit_profile`
  "set my next event" branch vs detecting intent in free text. (Recommend the command;
  free-text intent detection is fuzzy and would need the worker.)
- **Who can trigger it:** only dormant/post-event athletes, or any `complete` athlete
  (i.e. also a mid-block "I changed my goal race")? The reset + replan is the same; the
  gate differs.
- **How the old plan is retired (#1)** — the make-or-break decision.
- **Old race row** — mark `completed` or leave (#3).

## Constraints / gotchas

- **No new migration.** Reuses dormant columns + the existing races/plans/profile tables.
- **Web-only — push (Vercel), NO `fly deploy`** (the worker coach is untouched; re-activation
  is engine-side, Vercel). If you find yourself changing `worker/`, stop — that's out of the
  agreed shape.
- **`pause.ts` / `bot.ts` / the engine collide across sessions** (`CLAUDE.md` §10). `git
  status` first; if foreign uncommitted changes are present, stop and flag. Commit + push
  promptly when green so another session's `git add` can't sweep your work.
- **Don't reopen anti-goals** (`CLAUDE.md` §5): no Inngest, no manual-log fallback, no web
  onboarding route. The trigger is a Telegram command.
- **Verify, don't assume:** the idempotency gate (#1) is the one that silently produces a
  wrong result (new race, stale plan). Add a test that proves a fresh plan with the new
  event's dates is generated, not the old one.

## Definition of done

- A dormant post-event athlete who runs the command (and names a new dated event) gets a
  **new** `races` row, a **fresh** plan for that event, `pause_reason` cleared, daily
  check-ins resumed — verified the plan is new, not the stale one (#1).
- The reset keeps durable profile facts (no re-asking experience/days/long-run-day).
- Stale-row handling per the decision (#3); calendar reflects the new plan for a connected
  athlete.
- Tests for the reset + the not-stale plan + `exitDormant` firing; `npm run typecheck`,
  `npm run lint`, `npm run test`, `npm run build` all green.
- Commit + push (web-only). Update `Specs/CHANGELOG.md` (next version),
  `Specs/ONBOARDING_V4.md` §10 (W3 → fully done), and `claude-status.md` per §8.

## After W3b

Remaining v4 (unscheduled): **W4** (ULTRA U1 catalog + `event_kind` + athlete-stated
adventure fill — also unblocks W1's deferred recap/adventure-fill half), **W5** (web
positioning copy — David wordsmiths), **W6** (eval harness — the launch gate before opening
to more users). U2 (50mi+ renderer work) is deferred (§6). The W1 DRAFT framing copy and the
W3a `POST_EVENT_PAUSE_NOTICE` still want David's voice pass.
