# Onboarding reflection — capture the ramble, mirror it back, carry it forward

_Status: **both sessions built.** R1 shipped 2026-06-10 (session 57, commit `a813ea3`). **R2 built 2026-06-10 (session 58; CHANGELOG v0.7.34 is the build log)** — David approved the plan and decided the pocket-turn message shape (see the build-record note below §2.4). Written 2026-06-10 after the Nathan transcript (`transcripts/nspady_gmail.com.md`) and a design conversation. `SPEC.md` §3.9 still untouched pending David's explicit sign-off on folding this in, per the `ONBOARDING_V3.md` convention. Still owed before friends onboard: David's voice pass on the new copy + a staging-group pass._

---

## 1. The problem the transcript showed

The intake opener invites a ramble ("hit the mic and ramble if it helps, the more context the better") and it works — athletes hand over their whole running life. Nathan's first message carried four threads: a sub-5 mile, short-distance speed generally, strength/resilience, and injury avoidance with specific history (hip flexors → back spasms, knees). The flow extracted one thread, silently rewrote it (mile → 5k bucket, no acknowledgment, no consent), and never mentioned the other three again — not in the recap, not in the plan preview.

The compounding failures, each traced to code:

1. **The catalog has no floor.** `deriveBucketFromMiles` (`engine/numeric.ts`) maps `mi < 4.65 → '5k'`; only `> 28` routes to the uncatalogued-goal pocket. `applyStatedDistance` (`engine/pocket.ts`) then writes the bucket `stated` + `confirmed: true` — the pocket's acknowledge-proxy-consent behavior never fires at the bottom. The conversational layer kept saying "mile race, sub-5" while the slot layer held `5k`; the athlete first saw "5K" in the final plan preview.
2. **An affirmed recap confirms nothing in code.** Confirmation depends on the model re-emitting each slot as `stated` after "Looks right"; it didn't, so the generate gate walked five unconfirmed-inferred slots one "Quick check" per turn — every value already displayed and affirmed in the recap. Five identical confirms trained the athlete to rubber-stamp, which defeated the one confirm carrying real information:
3. **`goal_date` accepted a past date.** "September or later" became `2025-09-01` (model-emitted, wrong year, in the past — today was 2026-06-10) with no code-side future check, rendered as raw ISO in the confirm, rubber-stamped. Downstream: weeks-to-race clamped to 1 → "~1 weeks of base and build, growing from ~13 to ~22 mi/wk" alongside "No race locked yet" in the same message.
4. **The target time evaporated.** "Sub-5" appeared in the recap but drove nothing — 300s validated against the proxied bucket's band (`FINISH_TIME_RANGES_SEC['5k']` min 12:00) is implausible, so it was dropped or never checked. The athlete's actual goal reached neither the plan nor the coach.

The diagnosis under the bugs: **the slot machinery is doing the understanding job, when it should only do the logistics job.** V3's determinism is hard-won (the 2026-06-05 loops) and stays — at the commit boundary. What's missing is a witness layer: capture the full ramble, reflect it back, persist it, and have the coach honor it.

This also reframes the "keep growing the catalog" instinct. The catalog will never be total, and catalog breadth is the axis Runna already competes on. The durable differentiator is the other layer — an agent coach reading freeform context daily. The pocket's "carry the athlete's words" (V3-W8) is the embryo of that; this proposal promotes it from edge-case salvage to the spine of intake.

## 2. The shape

### 2.1 The reflection beat (R2)

After the first goal-bearing athlete message, the bot's reply mirrors the whole picture in the athlete's own terms before any slot question: the headline goal, the supporting threads, the watch-outs. If the goal is out of catalog, the honest boundary + proxy-with-consent lands **here** — at the moment of maximum goodwill — merged into the reflection, instead of surfacing as an unexplained bucket in the final preview. If the goal is in catalog, the reflection collapses to a brief mirror and the flow advances; no extra consent turn for the marathoner who says "I want to run CIM."

Fires once per onboarding. The slot machinery, guardrails, chip policy, and commit gates are untouched — the reflection is message copy plus one new piece of captured state, not new state-machine branches.

### 2.2 Intents: one structured goal, plus a portfolio (R2)

The slot schema keeps exactly one plan-driving goal. Everything else the athlete states — secondary goals, qualities they're chasing, standing concerns — becomes `intents`: short freeform clauses in the athlete's words, appended across turns, deduped, never required, never confirmed (no guardrails; they're context, not commitments). At commit they land in the profile memory file as an "Also working toward" section, next to the existing "North-star goal" section that `commit.ts` already writes for accepted pocket goals (`upsertProfileSection` is the existing mechanism). The daily coach reads them and references them when relevant — that follow-through is load-bearing: intents that never resurface are a promise broken slowly instead of quickly.

### 2.3 Logistics reframe (R2, copy only)

The deterministic slot questions stay deterministic but get framed as scheduling, not comprehension: "Now the quick logistics — three questions so I can put this on a calendar." A form feels fine when it's labeled a form; it grates when it stands in for being understood.

### 2.4 Target transcript

Condensed; the full rewrite is the design conversation of 2026-06-10. Nathan's actual ramble, then:

> **BOT:** Here's what I'm hearing — four threads:
>
> The headline is a **sub-5 mile**. Behind it, you want real speed at shorter distances generally, you're building strength and durability, and staying ahead of injury matters — the hip flexor and quad tightness that's set off your back and knees before.
>
> One thing to be straight about: I don't build mile-specific plans yet. What I can do is build you a 5K block — the speed work overlaps heavily, and I'll keep mile-pace reps in the mix as it sharpens — with sub-5 as the target the whole way. The strength and durability threads ride along regardless; I'll weight your strength work around the hips and back.
>
> Build it that way?
> `[Do that]` `[Not quite my goal]`

Then: race timing ("I'll pencil mid-September 2026, about 14 weeks out"), the logistics beat (Strava read + experience, one turn), one injury-status question referencing the history he already gave, **one** recap showing the structured goal *and* the intents *and* the watch-outs, one "Looks right" that confirms everything, and a preview that closes the loop on all four threads with a correct horizon.

Original: 15 bot turns, 5 serial confirms, 3 of 4 goals dropped, wrong date, nonsense horizon. Target: 8 bot turns, 1 confirm, every thread reflected at least twice. Shorter, and reads as if more was understood — the richness comes from reflecting, not from asking more.

### 2.4.1 Build record (R2, 2026-06-10) — the composed-message decision

Decided with David at plan time: on a pocket-opening reflection turn the message is **composed**, not fully model-written. The model emits the mirror in a dedicated `reflection` output field (pure reflection prose — no question, no catalog talk, empty when the goal is the only thread); the engine prepends it to whatever message wins the turn at the single send point, with a canned transition ("One thing to be straight about:") ahead of the deterministic `pocketBody`, which now templates a known short-side goal time ("treating 5:00 as the goal"). Rationale: the boundary copy never drifts or hedges (§2.5's misreflection worst case), the model never needs to learn the catalog bounds, and the same composition path carries the mirror through race-lookup, guardrail-override, and backstop turns — paths where the model's message is discarded.

Two accepted consequences, found at design time: (a) when intents arrive *before* the headline goal, the reflection fires on the intents and the later-arriving goal never gets its own mirror — the race confirm / pocket offer / recap each echo it; (b) a first-ever pocket decline mid-flow (after a normal reflection) takes the redo path once — watch for it in the staging pass. Mid-flight pre-R2 athletes are grandfathered as reflected (no late mirror); the state fields shipped without a `V3_SCHEMA_VERSION` bump because a bump resets mid-flight athletes.

### 2.5 Known risks

- **Misreflection is the new worst case.** A reflection that misses or invents a thread is worse than no reflection, because it's framed as comprehension. The `[Not quite my goal]` path must take a graceful freeform redo, and reflection quality is the thing to test hardest (§R2 verification).
- **Intents have no guardrails by design.** There's no "required-core" for a missed strength goal. Accepted: the recap displays them, which is the athlete's chance to correct.
- **Coach follow-through.** §2.2's caveat. R2 ships the `coach.md` note in the same session so the promise and the keeping of it land together.

## 3. Relationship to existing specs

- **V3-W8 (pocket):** the reflection beat becomes where the pocket offer lands. R1's catalog floor makes pocket detection symmetric — finishing W8's intent, not new scope. `ULTRA_SUPPORT.md` §1's division of labor holds: the engine fails honestly at any boundary; catalog growth (up *or* down — a possible mile/short-speed phase) graduates goals out of proxy, demand-driven, in that doc's frame.
- **V1 scope locks:** untouched. Telegram-only, template-first plan gen, plan preview as the onboarding payoff all stand. A more radical shape — onboarding into coaching with the plan arriving days later — was considered and parked: it cuts against the template-first lock and delays the calendar-connect moment. Recorded here so it isn't redesigned from scratch if intake data later argues for it.
- **`ONBOARDING_V3_LIVE_FIXES.md`:** R1 absorbs T-9 (gen-time date assertion).

## 4. Change inventory

| # | File | Change | Session |
|---|------|--------|---------|
| 1 | `engine/numeric.ts` | catalog floor in `deriveBucketFromMiles` (DRAFT < 2.5 mi → null → pocket) | R1 |
| 2 | `engine/pocket.ts` | direction-aware proxy + `pocketBody` copy (short side proxies to `5k`) | R1 |
| 3 | `engine/guardrails.ts` | `goal_date` future guard; human-readable date in `formatSlotValue`; recap bulk-confirm | R1 |
| 4 | `engine/router.ts` | finish-time plausibility against real `distance_mi` when pocketed | R1 |
| 5 | `engine/commit.ts` | refuse/flag past `target_date` at commit (T-9); `target_time` committed against real distance | R1 |
| 6 | `steps/04-plan-preview.ts` | horizon sanity + pluralization | R1 |
| 7 | `engine/extract-and-advance.ts` | `intents` output field + rules; reflection-turn rules | R2 |
| 8 | `slots/slot-state.ts` | `intents: string[]`; `reflected` flag | R2 |
| 9 | `engine/router.ts` | reflection turn wiring; redo path | R2 |
| 10 | `engine/guardrails.ts` | recap renders intents + watch-outs | R2 |
| 11 | `engine/commit.ts` | "Also working toward" profile section | R2 |
| 12 | `steps/04-plan-preview.ts` | intents line in preview | R2 |
| 13 | `worker/prompts/coach.md` | surface intents when relevant | R2 |
| 14 | copy | logistics reframe lines | R2 |

## 5. Open decisions for sign-off

1. The catalog floor value (DRAFT 2.5 mi) and the short-side proxy (`5k`).
2. Reflection copy register — §2.4 is the draft; David reviews bot voice as with all athlete-facing copy.
3. Whether R1 ships ahead of full sign-off (recommended: it's bug fixes with their own evidence).
4. Intents cap (DRAFT: keep ≤ 5, newest-wins on overflow) and the profile section name.

---

---

## Session R1 — fix bundle: catalog floor, date guard, recap bulk-confirm

_Paste everything below this line into a fresh session._

---

Fix five live bugs in the onboarding v3 engine (`src/server/telegram/onboarding/`), all hit by one real user on 2026-06-10. Evidence: `transcripts/nspady_gmail.com.md` — read it first, plus `claude-status.md`, `Specs/ONBOARDING_REFLECTION.md` §1 (the trace), and `Specs/ONBOARDING_V3.md` §5.2–§5.4. This is a scoped fix pass: no new features, no catalog/enum growth, no reflection-shape work (that's session R2).

### Fix 1 — catalog floor (the mile became a 5K silently)

`deriveBucketFromMiles` (`engine/numeric.ts`) maps `mi < 4.65 → '5k'` with no lower bound; only `> 28` returns null and routes to the uncatalogued-goal pocket. Nathan's 1-mile goal was bucketed `5k`, `stated` + `confirmed: true`, via `applyStatedDistance` (`engine/pocket.ts`) — no acknowledgment, no consent. The transcript shows the bot saying "a mile race with a sub-5 goal" while the slots held `5k`; the athlete first saw "5K" in the plan preview.

Fix: distances below **2.5 mi (DRAFT — flag in your wrap-up for David's review)** return `null` → the pocket. The pocket needs to become direction-aware: `PROXY` is hardcoded `'marathon'` and `pocketBody` says "I top out at the marathon." Short side: proxy `'5k'`, copy in the register of: "A mile-specific plan is past what I build right now. What I can do: a 5K block with mile-pace work in the mix, treating your target as the goal the whole way. Want that?" Keep the existing consent chips and `OutOfCatalogGoal` shape (`slots/slot-state.ts` — `proxy` is already a field; set it per direction). The athlete's words already ride to commit (`commit.ts` "North-star goal" section) — verify that path works for the short side too.

### Fix 2 — recap bulk-confirm (five serial confirms after an affirmed recap)

Transcript 15:01–15:07: full recap → "Looks right" → then five individual "Quick check — I've got your X as Y. Right?" turns for values displayed unchanged in that recap. The 2026-06-05 hardening (monotonic merge, `pending_confirm`, attempt backstop in `engine/guardrails.ts`) is working; the gap is that an affirmed recap confirms nothing in code — confirmation depends on the model re-emitting each slot as `stated`, and it doesn't reliably do that.

Fix — the invariant to enforce: **after an affirmed recap, no deterministic confirm may fire for a slot whose value was displayed unchanged in that recap.** Suggested mechanism (yours to shape): when `buildRecapMessage` goes out, record the displayed slot/value pairs on state; on affirmative resolution — the recap chip (`That's it` / value `yes`, see the existing fast paths in `engine/router.ts` ~lines 128–160) deterministically, typed affirmation via the model's next turn resolving to `generate` with no contradicting fills — mark those slots confirmed through `mergeFills`' monotonic path (`stated` re-emit), exactly as `resolveConfirmAndAdvance` does for a single slot. Mind the v2 lesson (`ONBOARDING_V3.md` §1.1): no rigid typed-yes parser; chips resolve in code, typed text stays model-interpreted.

### Fix 3 — `goal_date` future guard + human-readable dates

"September or later" was stored as `2025-09-01` — the wrong year, a date in the past — confirmed as raw ISO ("I've got your race date as 2025-09-01. Right?") and rubber-stamped. No code-side future check exists on the v3 path.

Fix, three layers: (a) **code** — in `coerceFill` or a post-merge step in `engine/guardrails.ts`, a `goal_date` in the past resets to unknown (the gate re-asks; a wrong date must not survive to a confirm, since fix 2 makes confirms rarer and rubber-stamping is proven); (b) **prompt** — one rule in `extract-and-advance.ts`: emitted dates must be in the future relative to the current date the prompt already carries; a bare month resolves to the next future occurrence; (c) **render** — `formatSlotValue` (`guardrails.ts` ~line 243) formats `goal_date` as "Sep 1, 2026" in confirms and recaps; a wrong year should be visible to a human. Also (d): `commit.ts` refuses to commit a past `target_date` — log loudly and route back to intake rather than generating. This absorbs T-9 from `Specs/ONBOARDING_V3_LIVE_FIXES.md`; mark it there.

### Fix 4 — plan-preview horizon sanity

`steps/04-plan-preview.ts` rendered "~1 weeks of base and build, growing from ~13 to ~22 mi/wk" — a past race date clamped weeks-to-race to 1, and the copy contradicted "No race locked yet" in the same message. With fix 3 this state should be unreachable; still: fix the pluralization, and below a small-weeks threshold (DRAFT 3) don't render a build arc — log it, since reaching it means an upstream invariant broke.

### Fix 5 — `target_time` validated against the real distance

"Sub-5" reached the recap but neither the plan nor the race row — 300s against `FINISH_TIME_RANGES_SEC['5k']` (min 12:00) is implausible. When the goal is pocketed, validate `target_time` against the athlete's REAL distance: a pace-envelope window from `out_of_catalog.distance_mi` (floor ~3:50/mi, ceiling ~25:00/mi — the `ULTRA_SUPPORT.md` §3.2 decision #7 mechanism; 5:00 for one mile passes). The bucket table stays as the fallback when no concrete distance exists. At commit, the race row already carries `realDistanceMi` (`commit.ts`); make sure `target_time_sec` rides with it.

### Verification

- Unit tests in the existing suites: floor → pocket with the short proxy and copy; recap bulk-confirm (the exact Nathan fill sequence as a regression — affirmed recap, then zero "Quick check" turns); past-date reset + future-month resolution + human-readable rendering; pace-envelope `target_time` for a pocketed 1-mile goal.
- `npm run typecheck`, `npm run lint`, `npm run test`; prettier on changed files only.
- Update `claude-status.md` per the house convention. Note that a staging-group pass (`docs/testing-onboarding.md`) is required before friends see this.

### Scope guards

- No new buckets or enum values; no template/renderer/worker changes (fix 5 touches commit wiring only); no v2-path changes.
- Do not build the reflection turn, intents, or any copy reframe — that's session R2.
- If a fix wants to expand beyond these five, stop and ask.

---

---

## Session R2 — the reflection shape: mirror the ramble, carry the intents

_Paste everything below this line into a fresh session._

---

Build the reflection shape for onboarding v3, specced in `Specs/ONBOARDING_REFLECTION.md` §2 (read it first — including the target transcript in §2.4 and the risks in §2.5 — plus `claude-status.md` and `Specs/ONBOARDING_V3.md` §5). **Session R1 (the fix bundle in the same spec) must be landed first**; the reflection beat depends on the catalog floor and the recap bulk-confirm.

The one-line design: the slot machinery keeps doing logistics; a new witness layer does understanding. Athletes ramble, the bot mirrors the whole picture back once, the non-plan threads persist as `intents`, and the recap/preview/daily-coach all reference them. Guardrails, chip policy, and commit gates do not change.

### 1. Intents capture

- `slots/slot-state.ts`: `intents: string[]` on `V3OnboardingState` (athlete-voiced short clauses, e.g. "speed at shorter distances", "build muscle strength and resilience"). Cap at 5 (DRAFT), newest wins. Plus a `reflected: boolean` flag.
- `extract-and-advance.ts`: a new `intents` output field on the tool, with rules: capture stated goals/qualities/concerns that are NOT the plan-driving slots; the athlete's own words, compressed, never invented; emit only new ones (the engine appends + dedupes in code). Injury specifics keep flowing to the injury slots — intents are not a second injury channel.

### 2. The reflection turn

On the first turn whose extraction yields goal-bearing content (fills on goal slots, `goal_distance_mi`, a `race_lookup_query`, or intents), and `reflected` is false, the bot's reply is the reflection. Wire it in `engine/router.ts`:

- **Out-of-catalog goal** (the pocket is opening this turn): the reflection and the pocket offer are ONE message — mirror the threads, state the boundary plainly, offer the proxy, consent chips. The target copy register is §2.4 of the spec. The existing pocket consent fast paths handle the chips unchanged.
- **In-catalog goal:** a brief mirror (2–3 sentences, threads named in the athlete's words), then advance to whatever the gate asks next — no consent beat, no added turn beyond the mirror itself riding atop the next question.
- The reflection prose is model-written (it must echo the athlete's words; canned copy can't). Constrain it via `extract-and-advance.ts` rules: name every captured thread, invent none, the boundary sentence is plain and unhedged, and the message ends with the consent question or the next slot question — no orphan reflections. Set `reflected: true` either way.
- **Redo path:** the `[Not quite my goal]` chip (or an athlete pushing back in text) clears the pocket if open (`declinePocket` exists), keeps `intents`, resets `reflected` to false, and asks for a restatement in one line. One redo; after that the flow proceeds normally (the recap is the net).

### 3. Persistence and rendering

- `engine/commit.ts`: write intents to the profile memory file as an "Also working toward" section via `upsertProfileSection`, alongside the existing "North-star goal" section (~line 197).
- `engine/guardrails.ts` `buildRecapMessage`: an "Also working toward: …" line from intents, and keep the existing injury watch-outs line adjacent — the recap shows the portfolio, not just the slots.
- `steps/04-plan-preview.ts`: one deterministic line referencing intents (e.g. "Also on the radar: short-distance speed, strength — the plan's strength sessions carry that."). Keep it modest; no model call in the preview.
- `worker/prompts/coach.md`: a short note — the profile's "Also working toward" section is standing context; reference it when a session serves it ("today's strength block is doing double duty for your back history"), never as a recited list in every message.

### 4. Copy reframe

The transition into the slot questions, after the reflection: frame as logistics ("Now the quick logistics — a few questions so I can put this on a calendar."). Touch `buildAskMessage` intros only where they read as comprehension-testing; do not change question semantics or chip behavior.

### 5. Verification

- Unit tests: intents append/dedupe/cap; reflection fires once and only once; in-catalog collapse (no consent turn for "I want to run CIM"); redo path; commit writes the section; recap renders it.
- Fixture: Nathan's ramble (`transcripts/nspady_gmail.com.md` 14:56) as the canonical multi-thread input — assert all four threads are captured as goal+intents and none are invented. The eval harness (V3-W5) is deferred, so shape these as unit tests against the extraction output, not live-model evals; note in your wrap-up that reflection copy quality still needs a live staging-group pass (`docs/testing-onboarding.md`) and David's read of the actual bot voice before friends see it.
- `npm run typecheck`, `npm run lint`, `npm run test`; prettier on changed files only. Update `claude-status.md`.

### Scope guards

- No guardrail relaxation: slot confirms, gates, and chip policy stay exactly as R1 left them. The reflection is copy + the `intents`/`reflected` state, nothing more.
- No plan-optional onboarding, no delayed plan delivery (considered and parked — spec §3).
- No schema/DB migration: intents live in onboarding state and the profile memory file, not a new table or column. If that proves too thin, stop and ask rather than adding a migration.
- No worker changes beyond the `coach.md` note.
- All athlete-facing copy follows the repo's hard rules (CLAUDE.md §3) — must not read as AI-generated; the §2.4 target transcript is the register.
