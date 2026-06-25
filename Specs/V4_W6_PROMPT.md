# V4-W6 — onboarding eval harness (implementation plan, 5 parts)

_Self-contained. Assumes no memory of the sessions that built V4-W1…W5. Each part
below is sized for one working session — run them in order, commit each on its own._

## What you're building

**V4-W6: the onboarding eval harness** — a behavioral regression net for the
onboarding engine (`extract_and_advance` → `runTurn`), run against the **real Sonnet
model**. It is the launch gate in `ONBOARDING_V4.md` §9 / `ONBOARDING_V3.md` §7: the
thing that has to pass before onboarding opens to more friends, standing in for the
parser determinism v3 traded away when it moved the safety gate behind a model.

**This is not the coaching harness.** `Specs/EVAL_HARNESS.md` + `scripts/ab-model-eval.ts`
score `coach.md` daily messages through the worker agent (`worker/dry-run-agent.ts`).
W6 scores the **intake conversation** — different code, different fixtures, different
assertions. Reuse ab-model-eval's report / cost-tracking shape as a reference only.

The total scope (a prod hot-path change + a new eval subsystem + ~20 fixtures + an
optional judge) is too large for one session and mixes blast radii, so it is split
into **five parts**. Part 1 (caching) touches the live engine and ships on its own;
Parts 2–5 build the harness and are sequential.

## Two decisions already settled (David, this planning session)

1. **Athlete side = hybrid.** A simulated-persona LLM answers whatever the bot asks,
   from a fixture's persona + ground-truth fact sheet, with optional scripted
   "forced moves" for token-exact cases (a `[Skip]` tap, a named chip). The bot's
   questions vary run-to-run (Sonnet is non-deterministic); a fixed reply script
   desyncs on the terse/adversarial fixtures, so the simulator is the default and the
   forced move is the escape hatch.
2. **Scoring = deterministic gate + optional judge.** Deterministic behavioral
   assertions are the launch gate. A lightweight Opus voice judge is additive, behind
   a `--judge` flag, off by default (mirrors ab-model-eval's "judge deferred,
   side-by-side first" call).

## Architecture decisions (load-bearing — do not relitigate mid-build)

- **Drive `handleV3Message` / `handleV3Callback`, not `callExtractAndAdvance` alone.**
  Every v4 behavior — entry off-ramp, ultra off-ramp, adventure fill, pocket, numeric
  backstop, `resolveRace` — lives **downstream** of the model call in
  `engine/router.ts`. A harness that only calls the model tests none of it.
- **Vitest substrate, not a standalone `tsx` script.** The orchestration is heavily
  I/O-coupled. `engine/__tests__/router.test.ts` already proves the exact `vi.mock`
  seam that stubs all of it (Telegram send captured, Supabase, `lookupRace`,
  `commitSlots`, plan-gen, dormant helpers) while `callExtractAndAdvance` is mocked.
  The harness is that same setup with the model call made **real** and state threaded
  in-memory across turns. A plain script can't use `vi.mock`, so it would force a DI
  refactor of the live `runTurn` hot path — real risk for no gain. (`EVAL_HARNESS.md`
  says "not a Vitest suite", but that was scoped to the coaching harness, which runs
  the worker agent binary — a different constraint that doesn't apply here.)
- **Co-locate at `src/server/telegram/onboarding/engine/__evals__/`**, the same
  directory depth as `engine/__tests__/router.test.ts`. The `vi.mock` relative paths
  (`../../../bot`, `../typing`, `../../slots/slot-state`, `../../../pause`, …) are then
  **byte-identical** to router.test.ts — you copy that file's mock block instead of
  re-deriving it. Do **not** put this under `worker/evals/` (that is the coaching
  harness's home; this is engine code).
- **`*.eval.ts` files run by a separate `npm run eval`.** `npm test` is `vitest run`
  with the default `*.test.ts` glob, so `*.eval.ts` is invisible to the commit-gating
  run. Slow, real spend, non-deterministic → never in CI.

## Read first (source of truth)

1. **`Specs/ONBOARDING_V4.md` §9** — the v4 fixture/assertion deltas (keep-verbatim,
   convert, add). The authoritative list for what this harness asserts.
2. **`Specs/ONBOARDING_V3.md` §7** — the base V3-W5 fixture set and per-fixture
   assertions that §9 builds on.
3. **`src/server/telegram/onboarding/engine/router.ts`** — `runTurn`, `resolveRace`,
   `finishOnboarding`, the off-ramp / pocket / backstop logic the harness exercises.
4. **`src/server/telegram/onboarding/engine/__tests__/router.test.ts`** — the mock
   seam to copy. Note the `vi.hoisted` + `vi.mock` block at the top and the captured
   `sendMessage` spy.
5. **`src/server/telegram/onboarding/engine/extract-and-advance.ts`** — the one Sonnet
   call (`callExtractAndAdvance`), the `ONBOARDING_MODEL`, the cost constants, and the
   `summarizeState` / `buildSystemPrompt` shape the cache change touches.
6. **`src/server/telegram/onboarding/slots/slot-state.ts`** — `V3OnboardingState`,
   `initialV3State`, `loadV3State`/`saveV3State` (the in-memory store replaces these).
7. **`CLAUDE.md`** §3 (copy rules — apply to the judge rubric and any athlete-facing
   strings the fixtures assert on), §9 (scoped unit — confirm before expanding), §10
   (git/deploy — `git status` first; the tree sees concurrent sessions).

---

## Part 1 — Prompt caching on the engine call · ~30 min · standalone, prod

**Goal.** Cache the static tools+system prefix so back-to-back eval calls read it at
0.1× instead of full price. This is what pulls a full harness pass from ~$4 to ~$2.

**The change.** In `callExtractAndAdvance` (`engine/extract-and-advance.ts`), the call
passes `system` as a plain string. Convert it to a block with a cache marker — one
breakpoint on `system` caches the whole static prefix (tools precede system in the
cache order, so they're included):

```js
// before
system: buildSystemPrompt(),
tools: [EXTRACT_TOOL],

// after
system: [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
tools: [EXTRACT_TOOL],
```

The static block is ~3K tokens, over Sonnet's 1024-token minimum. The per-turn user
content (date, state, history, latest message) stays uncached — correct, it changes
every turn. The system prompt is already byte-identical per call by design (the date
rides in user content; see the comment above the `messages.create` call), so nothing
else moves.

**Also:** fold the cache token classes into the cost math — `cache_creation_input_tokens`
bills at 1.25×, `cache_read_input_tokens` at 0.1× — in `logOnboardingRun` and anywhere
per-turn tokens are summed for cost.

**Why it's its own commit (the prod/eval seam).** This edits the **live** onboarding
call. Caching only pays off when calls fall inside the 5-minute TTL: in the harness
they're seconds apart (~90% hit rate); in prod a real athlete is minutes-to-hours
between messages, so most prod turns are cold **writes** at 1.25× with no read to
amortize them. The prod premium is ~$0.002 per cold turn / ~$0.45 across all ~20
athletes ever — negligible, so enable it globally rather than branch on a flag. Name
this in the commit message; don't sell it as a free prod win.

**Files:** `engine/extract-and-advance.ts` (+ its test). **DoD:** a new unit test
makes two back-to-back calls and asserts the second reports `cache_read_input_tokens
> 0`; `npm run build` green; existing tests green. **Deploy:** web push — onboarding
runs in the Vercel webhook path, **no `fly deploy`**. **Depends on:** nothing.

---

## Part 2 — Harness mechanism (the seam runs end-to-end) · ~2 hrs

**Goal.** Drive the **real** engine through one full fixture conversation with all I/O
stubbed, and prove it runs.

**Build, all under `engine/__evals__/`:**

- **`onboarding.eval.ts`** (the vitest entry) — copy the `vi.hoisted` + `vi.mock` block
  from `router.test.ts` verbatim (the relative paths match at this depth), but:
  - `callExtractAndAdvance` is the **real** import, wrapped so each turn's output
    (`fills` + provenance + `next_action` + message + chips) is pushed to a turn log.
  - `loadV3State`/`saveV3State` are backed by an **in-memory store** keyed by
    athleteId, threaded across turns, seeded from the fixture's `initialState`
    (including `strava_snapshot`, so cold-start vs Strava-signal fixtures differ).
  - `lookupRace` is a **frozen per-fixture table** (query → `found`/`ambiguous`/
    `not_found`). This removes the DB dependency **and** a second nondeterministic
    Sonnet call — the race facts are the fixture's input, not the thing under test.
  - `commitSlots`, `generateAndPersistPlan`, `grantSignupCredit`, `enterDormant`,
    `setCheckBack`, `exitDormant`, `sendDavidAlert` are **recording stubs** (capture
    calls + args) — this is the assertion surface for "plan generated?", "went
    dormant?", "check-back captured?".
- **`drive.ts`** — `driveFixture(fixture)`: the turn loop. Seed state → feed the
  fixture's opening athlete message to `handleV3Message` → capture the bot reply
  (+chips) → simulator responds → route it (`handleV3Message` typed, `handleV3Callback`
  for a chip tap) → repeat. Ends when `generateAndPersistPlan` is called (completed),
  the off-ramp ack + check-back path fires (off-ramped), or a **~15-turn cap** trips
  (recorded as a failure: "didn't converge"). Returns the transcript, final state,
  recorded port calls, and the per-turn log.
- **`simulate-athlete.ts`** — `simulateAthlete(persona, facts, conversationSoFar,
  botMessage, chips)` → `{ kind: 'text', body } | { kind: 'chip', value }`. A Sonnet
  call in character (persona + fact sheet + conversation + bot's last message). Forced
  moves pin specific turns and override the call.
- **`scorecard.ts`** — minimal markdown: per-fixture pass/fail + the full captured
  transcript, total Sonnet spend, **cache hit rate** (from `cache_read` vs
  `cache_creation`), and a stamp = `ONBOARDING_MODEL` + `git rev-parse --short HEAD`.
- **One smoke fixture** (a clean marathon onboard) + one assertion (reaches plan-gen).
- **`package.json`:** `"eval": "vitest run src/server/telegram/onboarding/engine/__evals__"`.

**DoD:** `npm run eval` runs the smoke fixture against live Sonnet, prints cost + cache
hit rate, the assertion passes. **Deploy:** none (test infra). **Depends on:** Part 1
(for the cache-rate readout; functionally independent — the harness runs without it).

> In-session commit boundary if you run short: commit once the plumbing + smoke fixture
> is green, before adding fixtures.

---

## Part 3 — Phase 0: the v4 gate fixtures · ~2 hrs

**Goal.** Lock the v4 deltas that have no coverage today. Four fixtures + deterministic
assertions, mapped to §9.

**Fixture format** — one directory per scenario under `__evals__/fixtures/<name>/` with
a typed `fixture.ts` (typed, not JSON — we want `SlotState` types and frozen-lookup
closures):

```ts
export const fixture: OnboardingFixture = {
  name: 'beyond-50k-adventure-offramp',
  persona: 'Chase — terse, real answers; not chatty',
  facts: { goal: '44-mile mountain run, September', mileage: 15, days: 3,
           injury: 'long-standing right ITB' },
  initialState: { strava_snapshot: chaseSnapshot /* or null for cold-start */ },
  raceLookup: { /* query → frozen result; empty for athlete-stated efforts */ },
  forcedMoves: [],
  expect: { offRamp: true, planGenerated: false, eventKind: 'adventure',
            intentsInclude: ['44'], noBucketWritten: true },
};
```

**The four fixtures + assertions:**

- **General-fitness off-ramp** — `enterDormant` called, `generateAndPersistPlan`
  **not** called, no `keep_fit` plan, check-back captured or clean stop.
- **Beyond-50k off-ramp** (Western States 100 via frozen lookup, or a stated "44
  miles") — no bucket written, `intents` includes the race name, message states the
  50k ceiling, no consent chips.
- **Adventure → mid-month date** — `event_kind: 'adventure'`, `lookupRace` **not**
  called, fuzzy "September" → `goal_date` ending `-15`, `event_distance_mi` carries
  the real distance.
- **50k race → `ultra-50k`** — `goal_distance: '50k'`, real plan, no time-goal pace
  driver.

Use forced moves where a token-exact input is needed (a pocket-consent tap, a named
chip).

**DoD:** all four green against live Sonnet, scorecard renders them. **Deploy:** none.
**Depends on:** Part 2.

---

## Part 4 — Phase 1: full set + global invariants + scorecard diff · ~3 hrs

**Goal.** Complete the §9 set and turn the scorecard into a real regression net.

- **Port the keep-verbatim + convert v3 fixtures** (§9): chatty over-answerer, terse
  one-word-per-turn, voice-disfluent, adversarial "why do you need this", cold-start /
  no-Strava, injured, injury-skipper (`[Skip]` → `unknown`), messy time-goal ("10
  minute miles for a marathon", "4:25"), safety-contradiction, confirm-loop replay,
  goal-change (date must not survive); broad non-running, volume goal ("20 mi/wk").
- **Global invariants** run on every fixture: injury beat asked before any commit; no
  `generate` reaches commit with a required-core slot open; no `stated` provenance for
  a value absent from the fact sheet; the orientation sentence appears exactly once.
- **Scorecard:** previous-run diff (regressions visible) on top of the per-fixture
  rows.
- **Harden the simulator** on the terse / adversarial personas (the desync-prone ones).

**DoD:** full §9 set green, or any known-flaky fixture documented with why; prev-run
diff works. **Deploy:** none. **Depends on:** Part 3.

> Natural split if it overflows one window: port the fixtures first (commit), then add
> the invariants + diff (commit).

---

## Part 5 — Phase 2: `--judge` voice pass · ~2 hrs · optional

**Goal.** Add the one judge-shaped dimension — does the bot read as a person, per
`CLAUDE.md` §3 (no sycophancy, no "not X, that's Y", no rule-of-three filler).

- **`judge.ts`** — Opus, off by default behind a `--judge` flag, scores the captured
  transcript 1–5 with a one-line justification; the scorecard gains a voice column. The
  rubric is the `CLAUDE.md` §3 bar.

**DoD:** `npm run eval -- --judge` adds voice scores without touching the deterministic
pass/fail. **Deploy:** none. **Depends on:** Part 4 (transcripts to judge).

---

## Cost expectations

Per-turn (engine + simulator, both Sonnet at $3/M in, $15/M out): ~$0.02. Per fixture
(~10 turns): ~$0.18–0.22. Full §9 pass (~20 fixtures): **~$4 without caching, ~$2 with
Part 1**, ~1M tokens. `--judge` adds ~$1 (Opus voice pass per fixture). Phase-0 subset
(4 fixtures): ~$0.80. Variance ±30% on turn count / persona chattiness. The runner
prints the total — keep it visible.

## Constraints / gotchas

- **Mock-path coupling.** The harness lives or dies on the `vi.mock` paths matching the
  router's import graph. Co-locate at `engine/__evals__/` and copy router.test.ts's
  block. If those imports ever move, the mock list moves with them — same fragility the
  existing router.test.ts already lives with.
- **Frozen lookup, not real.** `lookupRace` itself calls Sonnet and needs the race DB.
  Freezing it per-fixture is deterministic and isolates the test to the engine's
  handling. Keep the frozen table in the fixture, one place.
- **Assert on state, not prose, where possible.** The turn log + final state + recorded
  port calls are the robust surface. Reach for message-text regex only when there's no
  state field (e.g. the 50k-ceiling line).
- **The provenance invariant needs ground truth.** "No `stated` for the unstated"
  compares each `stated` fill against the fixture's fact sheet. Where that's fuzzy,
  mark it judge-assisted rather than forcing a brittle deterministic match.
- **Scope (`CLAUDE.md` §9).** This is test/eval infra plus one 3-line prod change. No
  refactor of `runTurn`, no new tables, no migration, no worker change. If you reach
  for any of those, stop and confirm.
- **Git discipline (`CLAUDE.md` §10).** `git status` first; the tree sees concurrent
  sessions. Part 1 is a web push; Parts 2–5 are commit-only (no deploy).

## Definition of done (overall)

- Part 1 cached and pushed; cache hit visible in `usage`.
- `npm run eval` runs the full §9 fixture set against live Sonnet and gates on the
  deterministic assertions; `--judge` adds the optional voice pass.
- The scorecard writes a git/model-stamped markdown with per-fixture pass/fail, the
  transcripts, cost, cache hit rate, and a previous-run diff.
- `npm test` is unaffected (eval files excluded by the `*.test.ts` glob).
- The launch gate is real: a v4 delta regression (off-ramp stops firing, a date stops
  resolving, a generate slips past an open slot) fails a fixture.

## Spec governance (per `CLAUDE.md` §2 — apply only on sign-off)

On completion, do **not** edit `SPEC.md` unilaterally. The updates that follow sign-off:
a `Specs/CHANGELOG.md` entry (next version); `Specs/ONBOARDING_V4.md` §10 V4-W6 line →
built; `claude-status.md` per §8. Flag these in the wrap-up rather than applying them
without a go-ahead.
