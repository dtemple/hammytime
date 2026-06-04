# EVAL_HARNESS.md — coaching-quality eval harness

**Status:** deferred / proposed (post-launch). Not built. Not in the v1 critical path.
**Author:** dtemple (drafted with Claude, 2026-06-04)
**Relates to:** `Specs/SPEC.md` §6 (plan-quality variance risk), §7 (schema validator as the only content-quality gate), §5 (model selection / "A/B Sonnet vs Opus on yourself"); `worker/run-agent.ts`, `worker/folder.ts`, `worker/prompts/coach.md`.

## Why this exists

Today the only automated quality gate is the plan schema validator (structural safety caps at gen time). Everything about the *coaching message itself* — is it grounded in the athlete's real data, does it respect the safety caps conversationally, does it sound like a person rather than a chatbot — is checked by David reading the `messages` table by hand. That works at five athletes. It does not tell you whether a `coach.md` edit made the coaching better or worse, and it never catches a regression before a friend reads it on a long run.

This harness is a regression net for coaching output. Freeze a set of athlete states, run the real agent against each, score the output two ways, and diff the scores against the last run. When you change `coach.md` or switch the coach model, you see what moved.

It complements David's manual review and the schema validator. It does not replace either.

## Scope

In scope:

- A golden set of frozen, synthetic athlete states (fixtures) covering the scenarios that actually break.
- A runner that invokes the **real** agent config from `worker/run-agent.ts` against each fixture in an isolated folder, with no database and no Telegram send.
- A two-layer scorer: deterministic assertions (cheap, no LLM) plus an LLM judge against a rubric.
- A markdown scorecard, stamped with the coach model and a content hash of `coach.md`, that diffs against the previous run.

Non-goals (explicit, to avoid scope creep):

- No new database tables. The scorecard is a file under `worker/evals/results/`, committed to git.
- No CI gate in v1. Eval runs are slow, costly, and non-deterministic; they do not belong in the `npm run test` path that gates commits. Run on demand.
- No A/B model infrastructure beyond an optional flag (see Phase 2).
- No synthetic-athlete *generator*. Fixtures are hand-authored and version-controlled.
- Not a replacement for the live staging-bot loop in `docs/testing-onboarding.md` — that exercises onboarding plumbing; this exercises coaching judgment.

## Core loop

1. Load a fixture: a folder of input files plus a `manifest.json`.
2. Build a temp working directory and write the fixture's files into it — the same shape `worker/folder.ts::hydrate()` produces, minus the DB read.
3. Call `query()` with the **same options the worker uses in production** — same `allowedTools`, same `makeIsolationGuard(dir)`, same system-prompt rendering, same model. (This forces a small refactor; see below.)
4. Capture the output message, any memory-file writes (diff the folder before/after), and the cost/token usage.
5. Score: deterministic checks, then the LLM judge.
6. Append a row to the scorecard and diff against the previous scorecard.

The non-negotiable design constraint: the harness must run the *real* agent invocation. If it builds its own `query()` call, eval config drifts from prod and the results are fiction.

## Directory layout

```
worker/evals/
  fixtures/<scenario>/
    memory/                    the memory_files rows as .md files
    strava_recent.json         frozen Strava context
    marathon_training_plan.json
    plan_drift.md              optional, when the scenario needs drift
    manifest.json              run kind, incoming message, expectations
  rubric.md                    the judge's scoring criteria
  run.ts                       the runner (standalone script, like scripts/db-smoke.ts)
  judge.ts                     the LLM-judge call
  results/                     timestamped scorecards, git-tracked
```

Run with a new `npm run eval` script, modeled on the existing one-off scripts (`scripts/db-smoke.ts`), not as a Vitest suite.

## Fixture format

A fixture mirrors what `hydrate()` lays down for a real athlete: the memory files (`athlete_profile.md`, `race_calendar.md`, `personal_records.md`, `wellness_log.md`, `injury_log.md`, `open_questions.md`, `known_gaps.md`, `checkin_log.md`), the input-only `strava_recent.json` and `marathon_training_plan.json`, and optionally `plan_drift.md`. The static `exercises.md` corpus is copied in by the runner exactly as the worker does.

`manifest.json` carries the run context and the expectations:

```jsonc
{
  "kind": "daily_checkin" | "tg_message" | "checkin",
  "incoming_message": "can I bump Saturday's long run to 20?",  // for tg_message
  "expect": ["advisory_cap_warning", "asks_to_confirm", "no_silent_prescription"],
  "data_facts": {
    // the true values the message may cite; used by the grounding check
    "recent_runs": ["6.2 mi @ 9:14", "4.0 mi @ 9:40"],
    "long_run_pace": "9:30–10:00",
    "weeks_to_race": 11
  },
  "notes": "athlete is in build phase, last long run was 16 mi"
}
```

`expect` tags are the behavior contract for the scenario. Some are mechanically checkable (deterministic layer); the rest are handed to the judge.

## Fixture matrix

Start with ~10 covering the failure modes worth catching. Each is one directory under `fixtures/`:

1. **Normal easy day, mid-base** — baseline sanity; grounded, concise, no invented numbers.
2. **Long-run day in peak** — uses the correct pace zone from the plan, not a generic one.
3. **Fatigued athlete** — low readiness in `wellness_log.md`; expect a downgrade suggestion, not the prescribed hard day.
4. **Three-day Strava gap** — `strava_recent.json` shows a gap; expect acknowledgment, not pretending the week happened.
5. **Broken / stale Strava** — empty or stale `strava_recent.json`; the SPEC scope lock requires the agent to surface the gap explicitly. This fixture asserts it.
6. **Over-cap request** — "bump Saturday to 20" past the `caps.ts` long-run step; expect the advisory pattern (name the tradeoff, ask to confirm, comply — never refuse), per the dual-layer cap policy.
7. **Injury report** — "knee's been sore"; conservative response, writes `injury_log.md` and `open_questions.md`.
8. **Athlete insists after the warning** — follow-up to (6); expect compliance-after-confirm, not a second refusal.
9. **Plain logistics question** — grounded and short, no wall of markdown.
10. **`/checkin` battery** — asserts a `wellness_log.md` row is appended with readiness, soreness, and an optional body-part tag.

## Scoring

### Deterministic layer (cheap, fast, no LLM)

This catches hard regressions for near-zero cost:

- **Memory side-effects.** Diff the folder before and after the run. `daily_checkin` should append to `checkin_log.md`; `/checkin` should append a `wellness_log.md` row. Exact file-diff assertions.
- **Format hygiene.** Telegram-shaped: no markdown headers, within length bounds, no leaked tool or system artifacts, no narration preamble (the "Good. The files are updated. Here's the message:" leak noted in `claude-status.md`).
- **Mechanically checkable `expect` tags.** For the over-cap fixture, assert the message contains a confirm-style question rather than a flat prescription.

### LLM-judge layer (rubric, Opus)

Feed the judge the fixture's source data plus the output. Score each dimension 1–5 with a one-line justification. Rubric lives in `worker/evals/rubric.md`:

- **Grounding** — every pace, distance, and date traces to the provided data; flag any invented number. This is the hallucinated-pace guard done properly, because the judge has the source data in context.
- **Responsiveness** — answers the athlete's actual message or state, not generic boilerplate.
- **Safety judgment** — handles cap, injury, and fatigue cases per the advisory model.
- **Voice** — passes the no-AI-tells bar from `CLAUDE.md`: no sycophancy, no "not X, that's Y", no rule-of-three filler. This is the dimension that protects the daily bot voice.
- **Coaching value** — actionable and appropriate for the athlete's phase and plan.

## Scorecard and prompt-version stamping

Each run writes `results/<date>.md`: per-fixture rows, dimension scores, flagged failures, an aggregate, and a diff against the previous scorecard so regressions are visible.

Stamp every result with the coach model name, a content hash of `coach.md`, and `git rev-parse --short HEAD`. That stamp is the minimal prompt-versioning the eval needs — not a registry, just enough to know which prompt produced which scores. A later, separate step could persist the same `coach.md` hash onto `agent_runs` so production cost and quality tie back to a prompt version; the harness does not need that to be useful.

## Required refactor

Extract the `query()` options assembly out of `worker/run-agent.ts` into a reusable `buildAgentOptions(...)` that both the worker and the eval runner import. If the options stay inline, the eval tests a config that drifts from production and the scores lie. This is a prerequisite, not optional. It is a small, mechanical extraction — model, `allowedTools`, `makeIsolationGuard`, system-prompt rendering, `maxTurns`, `maxBudgetUsd`, scrubbed env — and it should not change worker behavior.

## Phasing

- **Phase 0 (smallest useful thing):** fixtures 1, 5, 6, 7 + `run.ts` + `judge.ts` + a markdown scorecard. No new tables, no Vitest coupling, no CI. Enough to regression-test a `coach.md` edit end to end.
- **Phase 1:** fill out to ~10 fixtures, add the deterministic file-diff layer, add the previous-run diff.
- **Phase 2 (optional):** an A/B mode that runs the same fixtures on Sonnet vs Opus, to settle the model question SPEC §5 left open.

## Cost

Roughly $0.30–0.80 per full pass at ~10 fixtures (10 coach runs plus 10 Opus judgments). Cheap enough to run on every prompt change. The runner should print the total so it stays visible.

## Limitations

- An LLM judge has variance and can be wrong. Treat the scores as a smoke alarm, not a grade — the value is *relative* movement on a fixed fixture set, not the absolute number.
- The harness only tests scenarios with a fixture. It will not catch a failure mode no one wrote down. It narrows the blast radius of a prompt change; it does not prove correctness.
- Fixtures drift from reality as the plan schema and `coach.md` evolve. They need maintenance, and a stale fixture can produce a false failure.

## Relationship to existing quality gates

- **Schema validator (SPEC §7):** structural safety at plan-gen time. Orthogonal — it gates plan *content*; this gates coaching *messages*.
- **Dual-layer caps (`caps.ts`, SPEC v0.7.10):** the harness asserts the chat-time advisory behavior the caps prompt is supposed to produce.
- **David's manual review of `messages`:** stays the catch-all for the long tail. The harness offloads the repeatable regression cases so manual review can focus on the novel ones.

## Open questions

- Where do fixture athlete states come from — hand-authored, or snapshotted (and scrubbed) from David's own real folder? Real snapshots are more representative but need a sanitization pass.
- Does the deterministic narration-leak check belong here, or is it better solved by the `<message>…</message>` output contract already designed in the plan file referenced in `claude-status.md`? If that contract ships, this check becomes redundant.
- Is grounding better as a deterministic number-extraction check or left entirely to the judge? Current lean: judge, because mapping free-text numbers back to source data deterministically is brittle.
