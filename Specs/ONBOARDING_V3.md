# Onboarding v3 — slot-filling conversational intake

_Status: proposal. Not yet reflected in `SPEC.md` or `CLAUDE.md`. Supersedes the Phase-A/Phase-C button-forward shape in `ONBOARDING_V2.md` (which is live today). Governance note at the end — `SPEC.md`/`CLAUDE.md` stay untouched until David signs off, same path v2 took._

_Author context: v2's onboarding (`src/server/telegram/onboarding/`) is a button-forward state machine with a single freeform "dump" at the end. Watching real users go through it surfaced a clear failure pattern (below). v3 keeps the parts that work — Strava-forward derivation, template plan-gen, the plan-preview payoff, voice, known-gaps — and replaces the deterministic question loop with a slot-filling conversation. The extract-and-confirm mechanism already exists in one place (`05-enrichment.ts`); v3 generalizes it to the whole intake._

---

## 1. Why v3 — the v2 failure modes (observed)

Three problems, all traceable to the current design:

1. **Typed answers get rejected on button screens.** Every button step replies `"Tap one of the buttons above to continue."` when the athlete types instead of tapping (`01-goal-setup.ts`, `02-training-shape.ts`, `03-injury-check.ts`). Users who answered in words hit a wall and got confused.
2. **No cross-question awareness.** Each question owns one slot and can't see the others, so an answer that also covers the next question is discarded and the bot asks it again. The redundancy is structural, not a copy problem.
3. **It doesn't feel smart.** A fixed interrogation reads as a form, not a coach. The first thing an athlete experiences from the product is a rigid script.

The fix is to stop treating onboarding as an ordered list of questions and start treating it as a set of facts to collect, filled from natural conversation.

### 1.1 What the first live transcript confirmed (and added)

Brenden's onboarding (`transcripts/bmulderr_gmail.com.md`, 2026-06-03) confirms the three problems above and surfaces more. v3 owns some; others belong to plan-gen, the worker coach prompt, or message logging, and are named here so the picture is honest.

- **Button taps aren't logged.** `handleOnboardingCallback` never writes an inbound `messages` row, so every selection is invisible and the transcript reads as the bot talking to itself. This blocks both human review and v3's own eval harness (§7), so it's a v3 prerequisite (§8 V3-W0).
- **The "Yep!" rejection.** Race confirm accepts only `yes/y/right/correct/"that's it"`, so "Yep!" failed (line 41–47). Exactly the rigidity slot-filling removes — **v3 owns this**.
- **Injury left unanswered, plan generated anyway.** The status question (line 92) got no answer and the plan rendered regardless. **v3 owns this** — injury is required-safety and code-gated.
- **History arrived too late to matter.** "Started running five weeks ago… comfortable with 10+ mile runs… first marathon" landed in the end-dump (line 136) *after* the plan was built. A five-weeks-running first-marathoner is a safety-relevant profile, and the plan never saw it. **v3 owns this** — experience and history are collected conversationally before plan-gen, and the engine flags this kind of contradiction (§5).
- **The time-goal loop (line 134–176).** "10 minute splits" → extracted `1:40:00`; "10 minute miles for a marathon, whatever that is in total time" → `7:20:00`; "4:25" → `0:04:25` (four minutes); finally "4 hours, 25 minutes" → `4:25:00`. Four wrong parses, and the fix path ("tell me again and I will redo it") threw away context each time so the athlete repeated themselves. **v3 owns this** — it's the sharpest evidence that extraction needs unit/plausibility reasoning, value computation, and field-targeted correction (§5).
- **Plan-gen put the race on the wrong day.** The renderer placed the marathon on Aug 8/15, ending a week before the real Aug 23 date (line 120–124); the worker agent caught and patched it live. **Out of v3 scope (plan-gen / renderer)** — but a flawless intake handing off a plan that ends before race day is still a failed first experience, so it's a must-fix dependency (§9).
- **Agent thinking leaked, and the worker barged into onboarding.** "I've caught the most critical structural error. Let me write to Brenden now given remaining budget" (line 118) is the worker coach narrating its reasoning, invoked mid-onboarding to repair the plan. **Out of v3 scope (worker coach prompt)** — but v3 must define the onboarding→worker handoff so plan correctness never depends on the worker catching a renderer bug (§9).

### 1.2 What the second live day added (2026-06-05)

Two more real transcripts — David's re-onboard (`transcripts/davidjtemple_gmail.com.md`, Western States 100) and Chase's (`transcripts/chaseheaton_gmail.com.md`, a 44-mile non-race mountain run). Much of the engine worked as designed: Chase named three goals in one message and the extractor caught all three; the Strava stated-back confirm landed cleanly. Four problems surfaced:

- **Out-of-catalog goals wedge the flow.** Both athletes named goals with no legal `goal_distance` value (100 mi; 44 mi). The extractor stored `marathon` as the nearest literal, the inferred-confirm guardrail correctly refused to generate on it, and the corrections ("Ultra," "44 miles") had no enum value to land in — the strand-and-loop the `ENUM_RULES` comment predicts. Catalog expansion is `Specs/ULTRA_SUPPORT.md`; the engine-side fix is the uncatalogued-goal pocket (§5.2) plus deterministic bucket derivation (§5.3) — together **V3-W8**.
- **The deterministic-confirm loop.** "Quick check — I've got your days per week as 3. Right?" fired seven times against seven "Looks right" replies over 85 minutes. Root cause is in the engine: `mergeFills` recomputes `confirmed` on every fill, so a re-emitted unchanged inferred value wipes a prior confirm, and nothing records that a deterministic confirm is pending — resolution depends entirely on the model re-emitting the slot with `stated` provenance. **Bug fix against W2, not new scope** — fix prompt: `Specs/V3_HARDENING_PROMPT.md`.
- **Stale `goal_date` across a goal change.** When Chase's goal switched from the looked-up Broken Arrow (2026-06-19) to Rae Lakes, the date silently survived — the recap read "Rae Lakes Loop 44mi — June 19, 2026" — while the demoted race lost its own date ("Broken Arrow 18k (date TBD)"). Same fix prompt.
- **The safety contradiction never got its chance.** 15 mi/week, 3 days, a long-standing ITB issue, and a 44-mile mountain goal ~14 weeks out is the §5.1 contradiction case made real — and the flow never reached the point where it would fire, because the confirm loop wedged first. Chase's profile becomes the contradiction fixture in §7.

---

## 2. Design principles

1. **Slot-centric, not section-centric.** There is one global slot schema for the whole onboarding. Every inbound message — text or voice — can fill *any* slot. The bot only ever asks for what's still unfilled; a topic already answered by an earlier message collapses to a one-line confirm or is skipped. This is what kills the cross-question redundancy.
2. **Freeform-first, but small answer sets always get chips.** Open slots start with a freeform prompt. Any question whose answer space is **three or fewer discrete options** (yes / no, yes / no / skip, a short either/or, a day of the week) **always ships chips** — the athlete is never asked to type a one-word reply the bot could have offered as a tap. Chips and typed text are interchangeable everywhere: a tap and the equivalent words fill the same slot, and typing is never rejected. The reverse holds too — open-ended slots (running history, an injury description) are never crammed into buttons.
3. **Required and safety slots are always filled; optional questions live on a budget.** The required core (goal, experience, distance/race, days/week, long-run day) and the safety gate (injury) get filled no matter what. Optional context (age, target time, tune-ups, schedule) is the model's to pursue within a global budget of ~6–8 questions across the whole flow; whatever's left becomes a `known_gap` for the daily coach.
4. **Silence — or a skip — is never a negative answer.** An unmentioned or skipped injury is `unknown`, not "healthy." The injury beat is always asked: `[Nothing right now]` is a positive "no issues" that satisfies it, a described injury fills it, and `[Skip]` leaves it `unknown`. Unknown never becomes "healthy" and never silently feeds the plan — it generates conservatively and hands the open gap to the daily coach. The `stated`/`inferred`/`unknown` provenance already in `05-enrichment.ts` carries this; v3 makes it a code-enforced invariant for every safety- and plan-driving slot: an inferred value is never written to one of those slots without an explicit confirm.
5. **Ground where a mistake is costly; stay light everywhere else.** Safety and plan-driving slots get an inline confirm at the moment they're filled. A final summary recap echoes the whole picture before the plan generates. Nice-to-haves ride without confirmation — they're correctable in daily chat and tracked as gaps.
6. **Payoff before enrichment.** The athlete sees a real plan as soon as the required slots are filled. There's no separate enrichment toll afterward — the conversation *is* the enrichment.
7. **Strava fills what it can; the athlete confirms, never blind-trusts.** Name, sex, timezone, and a fitness snapshot come from Strava. Inferred values (experience, days/week, long-run day) are stated back for correction in one turn, not asked cold.
8. **Set expectations before the first question.** A conversational flow on a bigger model pauses to think, so the athlete is told up front what's coming, that they can talk normally, and that they can leave and resume. Unexplained latency reads as a broken bot; an orientation turns the same pause into "it's working on it" (§4).

---

## 3. The global slot schema

One schema, filled across the whole conversation. Class drives behavior: required slots block plan-gen until filled; safety slots block on a positive answer; confirm policy decides whether a fill is echoed inline.

| Slot | Source | Class | Confirm policy |
|---|---|---|---|
| `name` | Strava `/athlete` | derived | confirm once (A1) |
| `sex` | Strava | derived | silent |
| `timezone` | Strava activity tz | derived | silent |
| `goal_type` (race / general fitness) | asked | required-core | implicit |
| `experience_tier` | Strava-inferred + asked | required-core (selects template) | inline confirm |
| `goal_distance` | asked / lookup | required-core | inline confirm |
| `goal_race` + `date` | `lookupRace` | required-core, or **deferred via "intended"** | inline confirm (plan-driving) |
| `days_per_week` | Strava-inferred + asked | required-core (plan-driving) | inline confirm |
| `long_run_day` | Strava-inferred + asked | required-core (plan-driving) | inline confirm |
| `injury_status` | asked (free-form + `[Nothing right now]` / `[Skip]` chips) | **required-safety** (always asked; skip → `unknown`, never "healthy") | gate, not a hard block |
| `injury_detail` (part + active / monitoring / past) | extracted from the free-form answer | safety-light | inline confirm |
| `age` | extracted | optional-deferred | none → `known_gap` |
| `target_time` | extracted | optional to ask, **plan-driving to confirm** | inline confirm when present (sets paces) |
| `tune_up_races` | extracted | optional-deferred | none → `known_gap` |
| `schedule_constraints` | extracted | optional-deferred | none → `known_gap` |
| `strength_equipment` | extracted | optional-deferred | none → `known_gap` |
| `motivation` / tone | extracted | optional | none |

Goal states: **committed** (named, confirmed race), **intended** (distance + placeholder timeframe, race bound later), and **general fitness / `keep_fit`** (no race, open-ended rolling base). v3 **retires v2's "day-to-day — coming soon" block**: a freeform "I just want to get fit, no race" is routed into `keep_fit` (the `base-maintenance` template, which already exists and renders today) rather than dead-ended. See §4 Opener 1 for the routing and the one boundary that stays (broad non-running fitness). The required-core set is otherwise identical to v2's — v3 changes *how* the slots are filled, not *which* slots gate a plan.

**Numeric and unit-bearing slots (`target_time`, pace, `age`, distance) get special handling** — this is where the live transcript failed worst. They are never accepted as a bare number. The engine resolves units, computes derived values, and sanity-checks against the goal before writing (§5). `target_time` is the clearest case: optional to *ask*, but once the athlete brings it up, it sets training paces, so it's confirmed inline like a plan-driving slot.

---

## 4. The flow — topical openers over the global schema

Phase A0/A1 (link + Strava OAuth) are unchanged from v2: `/start <link_token>` links the chat, then Strava connects and the callback resumes the flow. On return the bot has name, sex, timezone, and the fitness snapshot.

**Orientation + ready gate (new in v3).** Before the first question, the bot tells the athlete what's coming — what it'll ask about, that they can talk to it normally, that it may take a beat to think, and that they can leave and pick back up. This earns the slower turns: a conversational flow on Sonnet pauses to parse, and without a heads-up those pauses read as the bot being stuck. Now that the bot has the athlete's name from Strava, the message is personal. Draft Daybreak voice:

> Okay {firstname}, let's get started. I'm going to ask you about three things: 1/ your running goals, 2/ where your running's at right now, and 3/ any injuries to watch out for. Talk to me normally; I recommend using the mic so you can ramble a bit. More context leads to more helpful advice later. It takes a few minutes, and I'll sometimes pause a second to think. Step away whenever you want; you can always edit your profile in the "menu" below later. Ready?
> `[Let's go]`

The `[Let's go]` tap (or any typed reply) starts Opener 1. The gate is soft — a typed answer that already contains real content (an over-answerer who leads with "training for CIM in December") is parsed straight into the slot schema rather than discarded, so the orientation never blocks an eager athlete.

**Pause, resume, and edit — the `/edit_profile` menu.** Onboarding already resumes on its own: the dispatcher reloads `onboarding_state` on every inbound message, so a returning athlete who types anything continues from their current slot state. The orientation surfaces this through a persistent menu (the "menu" wording in the orientation copy above) carrying **`/edit_profile`**, which forks into two taps:

- **Update something** — the athlete types or speaks new information, and the same slot extractor folds it in (overwriting or adding), with an inline confirm on anything safety- or plan-driving.
- **Finish my profile** — the bot walks the athlete's still-open `known_gaps` and asks them, one at a time. This is the user-initiated complement to the daily coach's opportunistic gap-filling (W5): the same gap list, pulled forward when the athlete chooses to, rather than waiting for the moment each one pays off.

This works during onboarding (resume where they left off) and after it (add context, finish the profile later) — one affordance, both jobs. `/restart` stays the full redo.

After the gate, the bot works through topical openers. Each opener feeds the one global schema, so anything an athlete volunteers early is captured and not re-asked.

**Opener 1 — Goal + race.** "What are you training for — and do you have a race in mind?" Freeform. The extractor fills `goal_type`, `goal_distance`, race name/date, and often `experience_tier`, `target_time`, even `days_per_week` if the athlete is chatty. If a race is named, `lookupRace` runs and the match is confirmed inline (plan-driving). No race but a distance/timeframe in mind → the "intended" branch (distance + rough timeframe), as in v2's A4b.

**No-race / general-fitness routing (Option 1, resolved 2026-06-04).** An athlete who says, in freeform, that they just want to get or stay fit with no race is **routed into `keep_fit`** — the open-ended `base-maintenance` plan that already renders today — not blocked. v3 does **not** re-create v2's "day-to-day — coming soon" wall: a soft, freeform flow can't reliably gate intent anyway, and gating would re-introduce the "it didn't accept my answer" experience v3 exists to remove. Detection is unavoidable either way (the engine must pick a template), so routing in is both friendlier and less work than blocking. One boundary stays: **general *running* fitness** routes to `keep_fit`, but **broad, non-running fitness** ("I'm not really a runner — weight loss, lifting, cross-training") is outside what a running coach does, and the bot says so plainly rather than forcing a running base plan onto them. The daily coaching for a no-race athlete is handled by the in-scope non-race `coach.md` branch (§8 V3-W7); telling the athlete up front that the product is sharpest with a race is a deferred nicety (§8 dependencies).

**Opener 2 — Where you're at.** Pre-seeded with the Strava snapshot, the bot states its inferences and asks for a correction in one turn: "Looks like you're running ~4×/week, long runs on Sunday, around 30 mi/wk, with some tempo work — sound right?" This fills `experience_tier`, `days_per_week`, `long_run_day` by confirmation rather than cold questions. Anything already filled from Opener 1 is folded in, not re-asked.

**Opener 3 — Injuries / health.** Free-form first: *"Tell me about any past injuries or anything that's been nagging you recently."* Chips: `[Nothing right now]` `[Skip]`. Typed or spoken detail is parsed straight into the schema — body part(s) and status (active / monitoring / past), so it captures injury *history*, not just what hurts today. This is the safety beat, so the rule governs how the slot is *filled*, not whether it's asked (it always is): `[Nothing right now]` is a positive "no current issues" and satisfies the gate; a described injury fills it; **`[Skip]` leaves `injury_status` `unknown` — never "healthy."** A skip doesn't trap the athlete: the plan still generates, but conservatively (no injury overlay, flagged to the coach as unconfirmed), with the open gap handed to the daily coach to probe early. An injury that's described is confirmed inline.

**Cleanup.** Any required-core slot still unfilled gets asked directly. The bot won't reach the plan with a required slot open.

**Optional pursuit (within budget).** With required + safety locked, the model spends up to ~6–8 questions total on the highest-value optional slots — target time, age, tune-ups, schedule — choosing what's worth asking for *this* athlete. Whatever isn't captured is seeded into `known_gaps.md` for the daily coach to fill when it pays off (the W5 mechanism, reused as-is).

**Final recap.** Before generating, the bot echoes the full picture — name, race + date, distance, experience, days/week, long-run day, injuries, plus any optional context captured — with `[Looks right]` / `[Fix something]`. This is the summary confirm; combined with the inline confirms on safety/plan-driving slots, a misparse on anything load-bearing has two chances to be caught.

Phase B (generate + preview) and Phase D (next actions: calendar / adjust / done) are unchanged from v2. **Phase C — the standalone enrichment dump — is removed**: the conversation already collected that context, and the recap replaces the echo-confirm step. `seedKnownGaps` still runs at completion.

---

## 5. The per-turn engine

The new core. On each inbound onboarding message:

1. **Load** the global slot state (from `onboarding_state.partial`), the Strava snapshot, and recent conversation context.
2. **One combined tool call** (Sonnet, `extract_and_advance`) returns, in a single round-trip:
   - updated slot fills, each tagged `stated` / `inferred` / `unknown`;
   - which required and safety slots remain open;
   - the next message to send — a follow-up for an unfilled slot, an inline confirm, or the final recap;
   - which chips (if any) to attach to that message;
   - the optional-budget counter; and
   - a `next_action` of `ask` / `confirm` / `recap` / `generate`.
3. **Persist** the new slot state to `onboarding_state.partial`; send the message (plus chips).
4. **Code guardrails** (enforced in TypeScript, not left to the prompt):
   - `generate` is refused while any required-core slot is unfilled;
   - the injury beat is always asked; `injury_status` is only marked "none" by an explicit "nothing right now" (never by silence or skip); a skip leaves it `unknown`, which generates a conservative plan and opens a coach follow-up rather than recording "healthy";
   - an `inferred` value is never written to a safety or plan-driving slot without a confirm turn;
   - the optional budget is a hard counter the engine decrements, not a number the model is trusted to respect.

One combined call (rather than extract-then-ask as two calls) keeps the turn inside Telegram's webhook budget — Telegram retries slow webhooks, and v2 already runs synchronous LLM calls in this path. Extraction stays inline in the bot path, not the worker queue, to preserve the instant feel. The tool schema mirrors the existing `ENRICHMENT_TOOL` shape in `05-enrichment.ts` — provenance objects per field, plus the routing fields above.

**Model: Sonnet (`claude-sonnet-4-6`), not Haiku.** This is the athlete's first contact with the product, and v3 leans on the model for exactly the things Haiku is weakest at — parsing messy free-form input, reasoning about units and plausibility (the "4:25 marathon" case), and holding a natural coaching voice. v2's `05-enrichment.ts` ran Haiku and produced the time-goal loop in §1.1; that's the regression to avoid. The cost is higher per turn, but at 5–25 friends it's still small in absolute terms, and David has accepted it for the quality of the first run. Sonnet is the floor, not Opus: Opus's added latency works against the inline webhook path, and the deterministic plausibility layer (§5.1) already backstops the hardest numeric cases — so Opus is held only for a specific hard case that proves Sonnet insufficient, which the eval harness would catch. The added latency vs. Haiku is masked by a "typing…" indicator during the call (the worker already has `startTyping`; the onboarding webhook path needs the same).

### 5.1 Numeric slots, corrections, and contradictions

The live transcript's worst stretch was a numeric-extraction loop (§1.1). These behaviors exist specifically to prevent it:

- **Resolve units; never accept a bare number.** A time or pace is normalized to seconds with an explicit unit, and the echo always states the unit back: not "goal 4:25:00" but "a 4:25 finish — four hours twenty-five." "10 minute miles" is a pace, not a time.
- **Compute derived values.** When the athlete gives a pace ("10 minute miles for a marathon") the engine computes the implied finish (~4:22) rather than dropping the figure or guessing. When they give a finish, it can state the implied pace. This is reasoning the regex parser (`durations.ts`) can't do and the LLM extractor can.
- **Sanity-check against the goal, deterministically.** A code-side plausibility layer (not prompt-only, because Haiku flubbed exactly this) rejects values outside sane ranges for the distance — a "4:25" marathon resolves to hours, not minutes, because four minutes is impossible. Out-of-range or ambiguous → a single tight disambiguation, offered as chips per principle 2 (`[4h 25m]` `[4m 25s]`), never a silent guess. Sonnet plus this plausibility layer is what makes numeric extraction reliable where Haiku wasn't.
- **Corrections are field-targeted and carry context.** "Let me fix something" must re-open the *named* slot with everything else intact — not v2's "tell me again and I will redo it," which discarded context and re-ran the same error three times. The fix path edits one slot; it never restarts the section.
- **Surface safety-relevant contradictions, don't just store them.** When collected slots conflict in a way that affects safety — five weeks of running plus a first marathon in twelve weeks, or a goal pace far faster than recent Strava efforts — the engine flags it for confirmation before plan-gen rather than silently feeding a contradiction into the renderer. This is the moment the intake earns "coach," not "form."

### 5.2 The uncatalogued-goal pocket (V3-W8)

The 2026-06-05 transcripts (§1.2) showed what happens when an athlete states a real goal the catalog can't structure: the engine forces it into the nearest enum value and wedges. The pocket is the general fix, and it extends a boundary pattern v3 already has — the honest "I'm a running coach" line for broad non-running fitness (§4 Opener 1).

**Detection is a code state, not a model vibe.** When a goal lands outside the catalog — a race distance past the bucket bands (§5.3), a non-race objective with no lookup hit, a periodic volume target ("20 miles a week"), anything the structure can't yet hold — the engine marks the goal `out_of_catalog` explicitly. The model never silently writes the nearest bucket.

**The behavior is the same for every uncatalogued shape:**

1. **Acknowledge plainly** what the product can and can't build today. Daybreak voice, no hedging: "A 44-mile mountain run is past what I can build a structured plan for right now — I top out at the marathon."
2. **Offer the nearest in-catalog structure, with consent.** "What I can do: build toward the Double Dipsea and treat the 44 as the north star I coach you toward. Want that?" The proxy is the athlete's choice, never a silent substitution.
3. **Store the athlete's words faithfully** in a memory file at commit (the true goal in the athlete's own terms — name, distance, timeframe, why it matters), so the daily coach knows what the athlete is actually chasing even though the plan is structured toward the proxy.

The pocket is deliberately a catch-all: as the catalog grows (`ULTRA_SUPPORT.md` U1/U2, volume goals later), goals graduate out of it, and whatever's still unsupported degrades to an honest conversation instead of a broken one.

### 5.3 Deterministic distance-bucket derivation (V3-W8)

When a race is confirmed via `lookupRace` with a non-null `distance_mi`, the engine sets `goal_distance` **in code from the number** — never by model choice. The fill carries `stated` provenance (the athlete confirmed the race), so it doesn't trigger the inferred-confirm gate. Out-of-range distances (today: anything past ~28 mi) route to the pocket (§5.2) rather than the nearest bucket. The bands are wide on purpose — trail races run long, and a 27-mile "marathon" trains like a marathon. `ULTRA_SUPPORT.md` §3.1 carries the full band table and widens it when the ultra buckets land; the mechanism ships here, against the current five-bucket catalog. This removes the model mis-mapping class for *every* race, not just ultras: the model only maps freeform distance talk when no confirmed number exists.

---

## 6. Gaps, risks, and mitigations

| Risk | Mitigation |
|---|---|
| Silence or skip read as "no injury" | `injury_status` is marked "none" only by an explicit "nothing right now"; silence or `[Skip]` leaves it `unknown` → conservative plan + coach follow-up, never "healthy"; the beat fires regardless of budget (§2.4, §4 Opener 3). |
| Budget starves a required slot | Budget governs *optional* slots only; required-core slots are exempt and asked until filled; `generate` is code-gated on them (§5.4). |
| Cross-topic bleed (race message mentions an injury) | One global schema; any message fills any slot; filled topics are skipped or condensed (§2.1). This is the direct fix for the observed v2 redundancy. |
| Confirmation fatigue rebuilds the long back-and-forth | Inline confirm only on safety + plan-driving slots; one summary recap; nice-to-haves ride (§2.5). |
| Rambling, refusals, dead ends ("why do you need my age") | The global budget caps total questions; a refused or unanswerable optional slot is dropped to `known_gaps` and the flow moves on. |
| Bad voice transcription mid-slot | Inline confirms catch a garbled safety/plan-driving fill; the existing transcription-failure fallback ("mind typing it?") still applies. |
| Lost parser determinism → safety gate now model-mediated | An eval harness (§7) is a launch gate; the safety invariants are code-enforced (§5.4), not prompt-only. |
| Latency / Telegram webhook timeout | Single combined call per turn; a "typing…" indicator masks Sonnet's added latency; inline like today's enrichment (§5). |
| Resumability if the athlete walks away mid-flow | Global slot state persists in `onboarding_state.partial`; any inbound message resumes from filled slots without re-answering. The orientation surfaces a persistent "menu" affordance to step back in or add context later (§4). |
| Slower turns read as a broken bot | Orientation sets the expectation before the first question; a "typing…" indicator covers each pause (§4, §5). |
| Mid-flow edit ("actually, change my race") | A slot model overwrites naturally pre-plan — re-extract and the recap re-confirms. Post-plan edits route to the conversational coach, as v2 already does. |
| Cost rises from per-message LLM calls | Per-message rather than once, and on Sonnet rather than Haiku — but at 5–25 friends still small in absolute terms; David has accepted it for a better first impression (§5). |
| Numeric/unit misparse (the live time-goal loop) | Unit resolution, value computation, a deterministic plausibility layer, tight disambiguation, and field-targeted correction (§5.1); `target_time` confirmed inline; dedicated eval fixtures (§7). |
| Selections invisible → can't review or eval onboarding | Log button taps as inbound messages (§8 V3-W0). Prerequisite, not optional. |
| Worker barges into onboarding / agent thinking leaks | Define the onboarding→worker handoff so plan correctness never depends on the worker (§9). Out of v3 scope but a named dependency. |
| Plan-gen anchors the race on the wrong day | Renderer date bug, out of v3 scope; flagged as a must-fix dependency (§9) — a broken plan undoes a good intake. |
| Out-of-catalog goal (44-miler, non-race adventure, volume target) wedges the flow | The pocket (§5.2): detected in code, acknowledged plainly, nearest in-catalog structure offered with consent, the athlete's words stored for the coach — never a silent nearest-bucket write. |
| Re-emitted fills wipe confirms → the same deterministic confirm repeats forever | Merge monotonicity, pending-confirm bookkeeping, and a never-three-times backstop (`Specs/V3_HARDENING_PROMPT.md`); observed live 2026-06-05 (§1.2). |
| Goal change leaves the previous race's date in `goal_date` | Code rule: a `goal_race` change with no accompanying `goal_date` fill resets the date; prompt rule: a demoted goal race carries its date into `tune_up_races` (same fix prompt). |

---

## 7. Eval / verification — replaces the lost parser tests

v2's parsers are unit-tested (`parsing.test.ts`, the per-step tests). v3 moves the safety gate behind a model, so it needs a behavioral harness, and that harness is a gate for opening to more friends (mirroring v2's "works end-to-end on David's own re-onboard" gate).

- **Fixture transcripts** covering: a chatty over-answerer (everything in the first message), a terse one-word-per-turn athlete, voice-disfluent input, an adversarial "why do you need this," a non-runner / cold-start (no Strava signal), a no-race-yet athlete, a **general-fitness / no-race-ever** athlete (routes to `keep_fit`, no block; recap and plan promise no race or taper) plus a **broad non-running** athlete (gets the honest "I'm a running coach" boundary, not a forced base plan), an injured athlete, an **injury-skipper** (taps `[Skip]`), and — drawn straight from Brenden's transcript — a **messy time-goal** athlete ("10 minute miles for a marathon," "4:25," "finish on my feet") plus a **safety contradiction** athlete (five weeks running, first marathon, twelve weeks out). Added 2026-06-05, from the real transcripts: an **out-of-catalog goal** athlete (a 44-mile non-race mountain run → the pocket, §5.2), a **confirm-loop replay** (the exact fill sequence that produced the seven-times "days per week" loop), a **goal-change** athlete (named race confirmed, then the goal switches — date must not survive), and **Chase's full profile** as a second contradiction fixture (15 mi/wk, 3 days, long-standing ITB, 44 mountain miles ~14 weeks out).
- **Assertions per fixture:** the injury beat is always asked; `injury_status` is recorded "none" only on an explicit "nothing right now," and a `[Skip]` leaves it `unknown` (never "healthy") with a conservative plan and a coach follow-up; no `generate` fires with a required-core slot unfilled; over-answered slots are filled and never re-asked; the optional budget is respected; provenance is never `stated` for something the athlete didn't state; no safety/plan-driving slot is written from an `inferred` value without a confirm; a pace is computed to a finish time and a "4:25" marathon resolves to hours; a correction edits one slot without restarting the section; a safety contradiction is surfaced before plan-gen. Added 2026-06-05: the same deterministic confirm is never sent more than twice and an affirmative resolves it; a `goal_race` change invalidates a date the athlete didn't restate; an out-of-catalog goal routes to the pocket (acknowledged, stored, proxied with consent) rather than a silent nearest-bucket write; a confirmed race's `distance_mi` sets `goal_distance` in code.
- **Run** against the production model (Sonnet) in a `scripts/` harness (the v2 test-reset loop in `docs/testing-onboarding.md` covers the live end-to-end pass). Depends on V3-W0 logging so transcripts capture taps.

---

## 8. Execution plan

v3 reuses most of v2's plumbing. New work, with rough sizes (S/M/L = hours / a day / multi-day):

- **V3-W0 · Log button selections · S — do first. ✅ Built and committed (2026-06-04).** Make `handleOnboardingCallback` write an inbound `messages` row for every tap (the typed-text path already logs via `logInbound`; the callback path doesn't). Without this, neither David nor the eval harness can read an onboarding transcript. Small, standalone, and it improves the live v2 flow immediately. _Done: `logInboundTap` logs each tap's human-readable label (via the extracted `labelForTap`) at the top of `handleOnboardingCallback`, covering step taps + the `← Back` tap; the Phase D `next:*` next-actions are mirrored in `handleNextAction` (bot.ts). Pending live e2e + deploy._
- **V3-W1 · Global slot schema + state · M. ✅ Built and committed (2026-06-04)** The slot catalog (class, source, provenance, confirm policy), the `onboarding_state.partial` shape that holds the live slot state, and the load/persist helpers. Reuse the provenance pattern from `05-enrichment.ts`.
- **V3-W2 · The per-turn engine · L.✅ Built and committed (2026-06-04)** The `extract_and_advance` combined tool, the router, and the code guardrails (§5.4). The big one — this is where determinism is traded for extraction + confirmation + budget tracking, so lean on the guardrails and the eval harness.
- **V3-W3 · Orientation, topical openers, Strava-seeded confirms + recap · M.✅ Built and committed (2026-06-04)** The orientation + ready gate, the `/edit_profile` menu (Update something / Finish my profile, the latter walking open `known_gaps`), the three openers, the snapshot-stated-back inference confirms, the cleanup pass, and the final recap. Reuse `lookupRace` and the Strava snapshot computer.
- **V3-W4 · Hybrid chips · M.✅ Built and committed (2026-06-04)** Generalize so any ask can carry chips, a tap *or* typed text satisfies the same slot, and any ≤3-option question (yes / no / skip) always renders chips (principle 2). The direct fix for the "typed answer rejected" complaint, worth shipping even ahead of the full engine.
- **V3-W5 · Eval harness + fixtures · M. Deferred (2026-06-05)** §7. Launch gate.
- **V3-W6 · Cutover + spec update · S. ✅ Shipped (2026-06-05).** v3 ships as the **default** flow; a feature flag is kept only as a fast fallback to v2 during rollout, not a long-lived A/B. _Done: `isV3Enabled()` (`slots/slot-state.ts`) gates new athletes onto v3 off the `ONBOARDING_V3` env flag — now live in production — while an athlete already mid-v3 (`state.flow === 'v3'`) stays on it regardless; the `flow === 'v3'` routing runs through `bot.ts` and `strava-resume.ts`. Spec updates from §10 landed: the v0.7.20 CHANGELOG/SPEC entry, the §3.9 v3 pointer note, the CLAUDE.md §4 update, and `ONBOARDING_V2.md` marked superseded. The §3.9 **body** rewrite stays deferred until the rest of the build (W5/W7/W8) lands, per the repo convention that the spec body never describes unbuilt code as current — the v0.7.20 entry remains the authoritative record until then._
- **V3-W7 · Non-race coaching branch in `coach.md` · S/M — in scope.** With general-fitness athletes now routed in (Opener 1), the daily coach can no longer assume a dated race. A conditional in `worker/prompts/coach.md`: when `goal_state` is `keep_fit` / no-race, drop the race/taper/peak/countdown framing and the goal-pace-session logic, and switch to a consistency/base narrative; suppress the known-gaps that only pay off against a race (`target_time`, `tune_up_races`). This is the floor that keeps a no-race athlete's *daily* experience from being race-framed and wrong — the deeper non-race progress model can come later. Pulled into v3 scope because plan-gen already renders `keep_fit`, so the coaching message is the only place the no-race athlete still degrades.
- **V3-W8 · Uncatalogued-goal pocket + deterministic distance derivation · S/M (added 2026-06-05).** The two engine behaviors from the second live day (§1.2, §5.2, §5.3): the code-detected `out_of_catalog` goal state with the acknowledge → proxy-with-consent → store-the-words behavior, and bucket-from-`distance_mi` derivation for confirmed races (out-of-range → the pocket). Prerequisite for `ULTRA_SUPPORT.md` U1, which widens the catalog underneath it; independent of W4–W6 and shippable in either order. (The 2026-06-05 confirm-loop and stale-date fixes are bug fixes against W2, not a workstream — `Specs/V3_HARDENING_PROMPT.md`.)

**Reused, not rebuilt:** Strava-forward plumbing (v2-W1), `lookupRace`, the template plan-gen engine (v2-W3), the `known_gaps` mechanism (v2-W5), the subscribed calendar feed, voice transcription, and the plan-preview `onEnter` hook.

### Sequencing

```
V3-W0 (logging) ──► V3-W1 (schema) ──► V3-W2 (engine) ──► V3-W3 (openers/recap) ──► V3-W6 (cutover)
       │                   │                                      │
       │                   └──► V3-W4 (hybrid chips) ─────────────┤
       │                                                          │
       └──────────────────────────────► V3-W5 (eval harness) ── gate before opening to more friends
```

V3-W0 and V3-W4 can each land first as standalone improvements to the live v2 flow. The full v3 intake gates on W2 + W3 + W5 passing on David's own re-onboard.

### Dependencies outside v3's scope (named, not owned)

Some things v3 names but doesn't own — a great intake handing off a broken plan still fails the athlete:

- **The onboarding→worker handoff boundary.** In the transcript a worker coach job ran mid-onboarding, edited the plan, and narrated its reasoning ("let me write to Brenden now given remaining budget"). v3's contract: onboarding renders the template plan, the recap confirms it, and the worker is handed control only on an explicit post-onboarding action (`[Adjust the plan]`, or the next morning). Plan correctness at hand-off is the renderer's job, not something the worker repairs live. This needs a one-paragraph decision when v3 lands, but the fix to the leak itself is in the worker coach prompt (`worker/prompts/coach.md`), not here. (The *non-race* `coach.md` branch is a different change and is in scope — V3-W7.)
- **The plan-gen race-date bug.** The renderer placed the marathon a week early. That's `src/lib/plan-templates/` (v2-W3), and it's a **must-fix dependency** for onboarding to feel trustworthy — track it separately from v3 but don't ship v3 on top of it unfixed.
- **Soft expectation-setting for no-race athletes (deferred).** Telling a general-fitness athlete up front that the product is sharpest with a race ("I'll keep you on a solid base, but coaching's tighter with something to aim at — want to point at one, even loosely?") is an onboarding-owned nicety, deferred for now. It's safe to defer precisely because V3-W7 fixes the actual coaching miscalibration rather than just warning about it — so this becomes a "nice to have," not insurance. Revisit if no-race athletes turn out to be a meaningful share of signups.

---

## 9. Decisions (resolved 2026-06-04)

All seven resolved by David; the body above reflects them. Kept here as the decision record.

1. **Drop the standalone enrichment dump entirely?** Recommend yes — the conversation subsumes it and the recap replaces the confirm. (§4)
> Confirmed
2. **Mid-flow edit of a plan-driving slot, pre-plan:** re-extract silently and let the recap catch it, vs. confirm each change as it happens. Recommend the former; the recap is the safety net. (§6)
> Confirmed
3. **Cutover:** feature-flag both flows during rollout (recommended, since v2 is live) vs. hard switch.
> Confirmed. v3 is the default.
4. **Pin the optional budget** — chosen band is ~6–8; pin at 8 for headroom, tighten from real transcripts.
> Confirmed
5. **The "menu" affordance** — Telegram bot-menu button vs. a persistent reply-keyboard, and what it offers (resume / re-send open question / add context later). Confirm this replaces the `/resume` slash command. (§4)
> Answer: add /edit_profile to the menu instead of /resume. The bot should then ask a question fork: "Update something" and "Finish my profile". Update should allow the user to enter some new information. Finish should have the bot start asking any known-gaps in their profile.
6. **Injury skip is a soft gate, not a hard block.** Confirm that `[Skip]` on the injury beat leaves `injury_status` `unknown` (never "healthy"), generates a conservative plan, and defers to the daily coach — rather than hard-blocking plan-gen. This softens the earlier hard-gate stance. (§2.4, §4 Opener 3)
> Confirmed
7. **Ready gate stays soft** — an over-answerer's first message is parsed, not discarded. (§4)
> Confirmed
8. **No-race / general-fitness handling (Option 1).** Route a freeform "just want to get fit, no race" into `keep_fit` rather than blocking; retire v2's "day-to-day — coming soon" wall. Keep the honest boundary for broad non-running fitness. (§3, §4 Opener 1)
> Confirmed. The non-race `coach.md` branch is **in v3 scope** (V3-W7); the soft expectation-setting message is **deferred / out of scope** (§8 dependencies).

Resolved 2026-06-05 (after the second live day, §1.2):

9. **Uncatalogued goals get a pocket, not a nearest-bucket write.** A goal the catalog can't structure is detected in code, acknowledged plainly, proxied to the nearest in-catalog structure only with the athlete's consent, and stored in the athlete's own words for the daily coach. One pattern covers oversize distances, non-race adventures, and future volume goals. (§5.2, V3-W8)
> Confirmed
10. **Bucket derivation moves to code.** A confirmed race's `distance_mi` sets `goal_distance` deterministically; the model only maps freeform distance talk when no confirmed number exists. Ships against the current catalog; `ULTRA_SUPPORT.md` U1 widens the bands. (§5.3, V3-W8)
> Confirmed

---

## 10. Spec governance

Signed off 2026-06-04. Applied the same way `ONBOARDING_V2.md` was:

- `SPEC.md` change-log entry **v0.7.20** records the approved direction and is the authoritative record in the interim. §3.9 carries a v3-approved pointer note now; its body still describes the built v2 flow and is rewritten to the v3 slot-filling flow as the workstreams land (the staging used for v0.7.8 → v0.7.10/v0.7.12, so the spec body never describes unbuilt code as current).
- `CLAUDE.md` §4 — the Telegram-only onboarding bullet — updated to note the v3 slot-filling intake (approved, in progress). The hard locks are unchanged: onboarding stays **Telegram-only**, Strava stays **required**, plan-gen stays **template-first**.
- No anti-goal is reopened. v3 adds no durable-job infra (extraction is inline in the bot path, as enrichment is today), no web onboarding, no manual-log fallback.
- `ONBOARDING_V2.md` is marked **superseded** for the flow shape; its still-accurate execution history (W0/W1/W3/W5 plumbing) is what v3 reuses.
