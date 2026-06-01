# Onboarding v2 — flow sketch + execution plan

_Status: proposal. Not yet reflected in `SPEC.md`. Two pieces here reverse locked v1 decisions (Strava-forward ordering revises §3.9; template plan-gen reverses a scope lock + an anti-goal). `SPEC.md` and `CLAUDE.md` stay untouched until David signs off — see "Spec governance" at the end._

_Author context: replaces the 7-step, ~15-fixed-question deterministic flow in `src/server/telegram/onboarding/`. Goal is to cut a 30+-message onboarding to roughly a minute of taps plus one optional freeform answer, and to move the plan payoff as early as possible._

---

## Design principles

1. **Structured for required + safety-relevant; conversational for everything else.** Anything that gates plan safety is a button or a guarded parse. Everything nice-to-have is soft, deferred, and confirmable.
2. **Payoff before enrichment.** The athlete sees a real plan before being asked to tell us more. Enrichment then feels like sharpening, not a toll.
3. **Strava fills what it can; the athlete confirms, never blind-trusts.** Inferred values are shown back and editable. The agent never writes an inferred value into a safety-driving field (paces, long-run progression) as if it were stated fact.
4. **Required is a short, enforced list.** Goal type, race/distance, experience tier, injury yes/no, long-run day. Everything else can arrive later.

---

## Part 1 — The flow

Legend: **[STRUCTURED]** deterministic, button or guarded parse · **[STRAVA]** auto-filled, confirm to edit · **[SOFT]** freeform, deferred-OK · copy is draft Daybreak voice.

### Phase A — Core (target: ~60 seconds, mostly taps)

**A0 · Link + welcome** — `[STRUCTURED]`
`/start <link_token>` resolves the token, links `telegram_chat_id ↔ athlete_id` (unchanged from today). Welcome line, then straight into Strava because it's the unlock.

> You're in. I'm Daybreak — I'll build your training and check in with you most mornings. First thing: connect Strava so I can read your running instead of interrogating you about it.
> `[Connect Strava]`

**A1 · Strava OAuth** — `[STRAVA]`
Tap opens the existing connect route (`/strava/connect?athlete_id=…`, state-signed). On callback success the bot resumes onboarding (new wiring — today the callback just says "connected"). On return we silently have: **name, sex, timezone, recent activity history**.

> Connected. Reading your last couple months… you're **{firstname}**, running out of **{timezone city}**. That you?
> `[Yep]` `[I go by…]`

_Reorder note vs David's sketch: Strava precedes name so name is derived, not asked then overwritten. Sex and timezone are captured here with no question at all._

**A2 · Goal** — `[STRUCTURED]`
> What do you want from me?
> `[Train me for a race]` `[Day-to-day coach — coming soon]`

"Coming soon" is disabled; tapping it offers a "ping me when it lands" capture rather than dead-ending. Race path continues below. (Data model should leave room for the no-race path now — see execution W2.)

**A3 · Experience** — `[STRUCTURED]`, pre-selected from Strava
Four tiers, David's wording. If Strava shows a clear signal (e.g. regular 6+ mi runs with intervals), pre-highlight the matching tier and let them override; cross-check rather than trust the tap alone.

> Where are you right now? I've pre-picked based on your Strava — change it if it's off.
> `[Beginner — can finish a 3-mile run]`
> `[Just for fun — run regularly, no structured training]`
> `[Done some training — 6+ mi regularly, some intervals/tempo]`
> `[Experienced — race half+ regularly, structured training]`

This tap is load-bearing: it selects the plan template. Strava weekly volume is the fine adjustment on top (a 25 vs 45 mi/wk "experienced" runner get different scaling).

**A4 · The race** — `[STRUCTURED]`, reuses today's `race-lookup`
> Which race are you pointing at? Name's enough — I'll pull the date and details. Haven't picked one yet? That's fine too.
> `[I'll name it]` `[No race yet →]`

`I'll name it` → web-lookup (existing `lookupRace`) → confirm. Date inferred from the lookup; ask only if not found.

> Found it: **CIM, Dec 6 2026, 26.2 mi, road**. Right?
> `[That's it]` `[Wrong race]` `[Enter manually]`

**A4b · No race yet — start training, pick the race later** — `[STRUCTURED]`
The way out for someone who wants to start now and commit to a race later. Two light taps give the plan something to aim at without a locked race:

> No problem — we'll start training and lock a race in when you're ready. What are you building toward?
> `[5K]` `[10K]` `[Half]` `[Marathon]` `[Just keep me fit]`

> Roughly when?
> `[~8 weeks]` `[~12 weeks]` `[16+ weeks]` `[No timeline — just build base]`

This records a distinct **"race intended, not selected"** state: `goal_distance` set, an optional placeholder `target_date` (today + timeframe), `goal_race_id = null`. It's separate from the day-to-day-coach "no race at all" state (A2). The template selector is unchanged — it runs on experience × distance × timeframe; the specific race is just absent. "Just keep me fit" + "no timeline" routes to a rolling base block instead of a dated countdown.

**Binding a race later.** Primary path is conversational: the athlete tells the coach ("I'm in for CIM, Dec 6"), the coach runs `lookupRace`, confirms, writes the real race, and re-anchors the plan calendar to the actual date. The daily coach also nudges when it's useful — "Locked a race yet? Name it and I'll tighten the build and add a real taper." A known-gap (W5) tracks "race unselected" until it's filled. (A `/setrace`-style command is a cheap fallback if the natural-language path proves unreliable.)

**Honest caveat for the plan:** a plan with no fixed date can't commit to a peak and taper — those hang off race day. The provisional plan runs base + build phases that are safe to extend; peak and taper get added when a real date binds. B1's preview should say so, so the athlete isn't surprised the plan looks like it "ends early."

**A5 · Days per week** — `[STRUCTURED]`, recommended default
Recommendation derived from experience tier + Strava frequency; buttons.

> Based on where you are, I'd train you **4 days a week**. Sound right?
> `[4 — recommended]` `[3]` `[5]` `[6]`

**A6 · Long-run day** — `[STRUCTURED]`, Strava-suggested default
> Which day's your long run? Looks like you usually go long on **Sunday**.
> `[Sun]` `[Sat]` `[Mon]`…

**A7 · Injury quick-check** — `[STRUCTURED]` (pulled out of the soft dump on purpose)
The one safety gate that does not get buried in freeform.

> Anything hurting or nagging right now?
> `[All good]` `[Something's bothering me →]`

`All good` → done. `Something's bothering me` → one short capture (body part + "still bugging you or just watch it?"), not the full 4-question-per-part loop of today. Detail can deepen later in daily chat.

### Phase B — Payoff

**B1 · Generate + preview** — plan appears here
Template selected from experience × distance × weeks-to-race, scaled to Strava volume, light customization (long-run progression, down weeks, taper). Preview states its assumptions out loud so corrections are easy.

> Here's your starting plan: **16 weeks to CIM, building from ~30 to ~50 mi/wk, long runs on Sunday, peaking at 20.** I assumed an easy pace around 8:30 and no time goal yet — both easy to change. We'll adjust this together as we go; it's a starting point, not a contract.
> `[Looks good]` `[Adjust it]`

For an A4b athlete (no race locked), the preview names the placeholder target and sets expectations about the open end:

> Here's your starting plan: **building toward a marathon, ~12 weeks out, growing from ~30 to ~45 mi/wk.** No race locked yet, so I've laid out base and build but held off on the taper — tell me the race whenever you pick it and I'll anchor the calendar and add the peak.
> `[Looks good]` `[Adjust it]`

### Phase C — Enrichment (optional, text or voice)

**C1 · The dump** — `[SOFT]`
> I've got enough to start. I coach better the more I know. Tell me a few things — type it however you want:
> • tune-up races before CIM
> • a time or distance goal, if you have one
> • your age
> • schedule constraints, gear, anything you'd tell a coach
> Or `[Skip]`.

Athlete answers in one free message. Agent extracts to structured fields (Haiku/Sonnet, inline in the bot path — not the worker queue). **Then echoes back for confirmation** — this is what keeps a loose parse trustworthy:

> Got it — **38**, eyeing a **sub-4**, **Berkeley Half on Oct 18** as a tune-up, early-morning runner. Fixing the plan around that. Anything off?
> `[All correct]` `[Let me fix something]`

Voice already works, everywhere, for free. `handleInboundVoice` in `bot.ts` downloads any Telegram voice note, transcribes it (`src/lib/transcribe.ts`, OpenAI `gpt-4o-mini-transcribe`), writes the transcript onto `ctx.message.text`, and dispatches it through the same path as a typed message — with a friendly "mind typing it?" fallback if transcription fails. Onboarding, wellness, and coaching all inherit it. The dump accepts a spoken answer with zero extra work; "hit the mic and tell me a few things" is already true.

### Phase D — Next actions

> `[Add to calendar]` `[Adjust the plan]` `[That's it for today]`

- **Add to calendar** — already a subscribed feed, not a download. `/api/calendar/{token}.ics` renders the athlete's current plan dynamically (long-lived token via `getOrCreateCalendarToken`, hourly cache), so plan edits propagate to a subscribed calendar automatically. The button just hands over the subscribe URL.
- **Adjust the plan** — hands off to the conversational coach agent (worker). This is where template + agent compose cleanly: template for the instant cold-start, agent for refinement.
- **That's it** — exits; daily check-ins take over.

### Cross-cutting — deferred-gap collection

Nice-to-haves not captured above (exact age, target time, recent long-run specifics) get recorded as **known gaps** in the athlete's memory, and the daily coach fills them when the ask pays off, not at random:

> Today's a goal-pace session. What finish time are you chasing? Tell me and I'll set the paces exactly.

---

## Required-vs-deferred, explicit

| Field | Source | Class |
|---|---|---|
| Name | Strava (confirm) | structured |
| Sex | Strava | structured (silent) |
| Timezone | Strava activity | structured (silent) |
| Goal type (race / day-to-day) | button | **required** |
| Experience tier | button + Strava | **required** (selects template) |
| Goal distance | lookup or A4b buttons | **required** |
| Specific goal race + date | lookup | required, or **deferred via A4b** (pick later) |
| Days/week | button (Strava default) | **required** |
| Long-run day | button (Strava default) | **required** |
| Injury yes/no | button | **required (safety)** |
| Injury detail | short capture | structured-light |
| Recent mileage / longest run | Strava | derived |
| Age | dump or daily | deferred |
| Target time | dump or daily | deferred |
| Tune-up races | dump or daily | deferred |
| Motivation / tone | dump | deferred |
| Schedule, gear, misc | dump | deferred |

Cut entirely: hours/week, the standalone name/sex/timezone questions, the per-part injury interrogation, the BYO build/help fork.

---

## Part 2 — Execution plan

Seven workstreams. W0 unblocks iteration and ships first. W3 (plan-gen) carries the parked decision and needs a go/no-go before it starts. Sizes are rough (S/M/L = hours / a day / multi-day).

### W0 · Test-reset harness — **do first** · S
The thing that lets us run the new flow over and over without nuking David's real account.

- David-only `/reset_test` command (gated on `DAVID_TELEGRAM_CHAT_ID`) — or admin-console button.
- In a transaction, delete derived rows for one athlete: `races`, `injuries`, `plans`→`plan_versions`, onboarding `memory_files`; null the profile columns on `athletes` (name/dob/sex/notes/asthma); `resetOnboarding`. Keep identity (`athletes` row, `telegram_chat_id`, allowlist).
- Flags: `--keep-strava` (default — preserve `oauth_tokens` so you don't re-OAuth each loop) and `--no-strava-data` (simulate the cold-start / new-runner branch without a second Strava account).
- **Also fixes a real bug:** today's `/restart` only resets `onboarding_state`, so re-runs duplicate race/injury rows and the plan-fork short-circuits on the leftover plan. Note it in passing.
- Files: new `src/server/telegram/onboarding/reset.ts`; wire a command in `bot.ts`. Test: run twice, assert clean DB.

### W1 · Strava-forward plumbing · M
Make Strava the early unlock and the data source.

- **New:** `getLoggedInAthlete()` in `src/server/strava/client.ts` (`GET /athlete` → firstname, sex, city/state, weight, measurement_preference). Net-new — client.ts has no profile fetch today.
- **Extend** `src/server/strava/activities.ts` with a fitness-snapshot computer: recent weekly mileage, longest run, run frequency → days/week default, dominant long-run weekday, road/trail mix. Widen the lookback beyond today's 14d (8 weeks).
- Derive timezone from the most recent activity's `timezone` field; fall back to profile city.
- **Resume-after-callback wiring:** `/strava/callback` (and the Telegram `/connect_strava` path) must kick the onboarding state machine forward instead of dead-ending on "connected."
- Risk: privacy settings can null profile fields; a zero-activity account has no timezone/snapshot. Every Strava-derived value needs a fallback ask. The `--no-strava-data` flag from W0 tests exactly this.
- Test: mock `/athlete` + activities; assert snapshot math and the empty-history fallback.

### W2 · State-machine restructure · L
Replace the 7 rigid steps with the Phase-A beats. Reuse what already works.

- Keep the dispatcher shape (`handleMessage` / `handleCallback` / `onComplete`) — it already supports button sub-flows (injuries step proves it).
- New/!rewritten steps: goal (buttons), experience (buttons + Strava pre-select), race (reuse `lookupRace`), days/week (buttons), long-run-day (buttons), injury quick-check (2-button + light capture). Retire `00-basics`, `04-anything-else`, `05-recent-mileage`, the per-part injury loop, and `06-plan-fork`.
- Add the **enrichment-dump step**: inline LLM extraction (pattern already exists — `02-races` calls Haiku for past-race parsing) → structured echo → confirm/fix. Keep these calls in the bot path, not the worker queue, to preserve instant feel.
- **Guardrail:** extraction writes `stated` / `inferred` / `unknown` provenance into memory; never fabricates a value for a safety field. Bake into the extraction system prompt and the memory write.
- Model three goal states, not two: **committed race** (`goal_race_id` set), **race intended but unselected** (A4b — `goal_distance` + placeholder `target_date`, `goal_race_id` null), and **day-to-day, no race** (A2). The A4b "pick later" binding re-anchors a provisional plan to a real date, so the schema needs to carry a plan that isn't yet tied to a race. Leaving this room now keeps both the pick-later path and the day-to-day coach from being later retrofits.
- Risk: this is the big one — you trade legible parsers + re-ask loops for extraction + confirmation + gap-tracking. Different, harder-to-test code. Lean on the echo-confirm to contain mis-parses.

### W3 · Plan generation — **decided: templates first, BYO later** · L
Templates are the v1 plan mechanism. BYO returns later as an optional path, not a blocker. Reverses the BYO scope lock + the server-side-plan-gen anti-goal — recorded in SPEC v0.7.8 (signed off 2026-06-01).

- Author a template library: distance × experience tier, parameterized by weeks-to-race and current volume. Half / full / beginner-base / intermediate / advanced / maintenance to start.
- Selector: experience × distance × weeks-until-race × Strava volume → template → scale (long-run progression, down weeks, taper) → emit `plan_json` against the **existing** schema (`src/lib/plan-schema.ts`, already mirrors the BYO output shape).
- The deferred **safety caps** (max long-run mileage, weekly ramp rate, hard-day spacing — flagged in `claude-status.md`) become load-bearing here. Build them as the validator the selector's output must pass.
- **Decided:** templates are the default and only path for v1; BYO is deferred and added later as an optional alternative. The existing `help`/manual path stays as the edge-case fallback in the meantime.
- Risk: at 5–25 friends the cost/regression worry behind the original BYO decision doesn't bite; the constrained "pick + scale a template" framing keeps the safety surface far smaller than open-ended generation.

### W4 · Preview, adjust loop, next-actions · M
- Plan-preview message with stated assumptions + `[Looks good]`/`[Adjust it]`.
- `[Adjust the plan]` → route to the worker's conversational coach (a `tg_message`-style job) seeded with "athlete wants to adjust the just-generated plan."
- `[Add to calendar]` → surface the existing subscribed-feed URL. Already built: `getOrCreateCalendarToken` (`src/lib/calendar-token.ts`), `renderPlanIcs` (`src/lib/calendar-render.ts`), and `/api/calendar/[token]/route.ts`; `bot.ts` already imports the token helper. Wiring only — no calendar build.
- Next-actions buttons after preview and after enrichment.

### W5 · Deferred-gap collection · M
- "Known gaps" list in athlete memory (which deferred fields are still unknown).
- Daily coach (`worker/prompts/coach.md` / `system-prompt.ts`) asks one gap when contextually valuable, writes the answer back, clears the gap. Tie the ask to the moment it pays off (target time ↔ first goal-pace workout).

### W6 · Spec update + cleanup · S
- Once shape is locked: draft the `SPEC.md` §3.9 rewrite + a change-log entry, and the plan-gen change-log entry (this is the one that touches a scope lock + anti-goal). David reviews before merge.
- Migration housekeeping: the duplicate-row behavior W0 papers over should get a real fix if `/restart` survives for friends.

### Already built (not workstreams — reuse)
- **Voice** — global transcription via `handleInboundVoice` + `src/lib/transcribe.ts`. The dump inherits it.
- **Calendar feed** — subscribed-feed infra (`calendar-token.ts`, `calendar-render.ts`, `/api/calendar/[token]`). W4 only surfaces the URL.

---

## Sequencing

```
W0 (reset)  ─┬─►  W1 (strava)  ─►  W2 (state machine)  ─►  W4 (preview/adjust)
             │                          │
             │                          └─►  W5 (deferred gaps, daily)
             └─►  W3 (plan-gen)  ───────────┘   [gated on go/no-go]
                                              W6 (spec) closes it out
```

W0 first (unblocks everything). W1 and W3 can now run in parallel once W0 lands (plan-gen decided). W2 needs W1. W4 needs W2 + W3. "Open to more friends" is gated on W2 + W3 + W4 working end-to-end on David's own re-onboard.

## Decisions (resolved 2026-06-01)

1. **Plan-gen (W3): templates first, BYO later.** Build the template library + agent selector as the v1 plan mechanism. BYO-plan returns later as an optional path — not a v1 blocker. Logged in SPEC v0.7.8.
2. **Spec update (W6): signed off.** Direction + the plan-gen reversal recorded in the SPEC v0.7.8 change-log; CLAUDE.md §4 scope lock updated to match. The full §3.4/§3.9 body rewrite lands with the W2/W3 build, so the spec body never describes unbuilt code as current.

_(Voice and calendar-feed are already built — no decision needed.)_

## Spec governance

Signed off 2026-06-01. The decisions here are recorded in `SPEC.md` (change-log v0.7.8) and `CLAUDE.md` (§4 scope lock). Template plan-gen reverses the v0.3 "BYO-plan generation" lock and the "no server-side plan-generation pipeline" anti-goal — BYO is deferred, not deleted. The Strava-forward, less-deterministic flow revises §3.9. Per the repo convention (e.g. v0.7.2–v0.7.6), the change-log entry is the authoritative record now; the §3.4/§3.9 prose bodies are rewritten as the W2/W3 code lands.
