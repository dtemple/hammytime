# Onboarding chips — policy + audit

_Status: **SIGNED OFF 2026-06-29.** This is the durable source of truth for chip
policy — chips are a version-independent mechanism, so they don't belong inside an
onboarding-version doc. `ONBOARDING_V4.md` (the live onboarding spec; v3 is stale)
and `SPEC.md` carry a one-line pointer back here. The policy (§4) and the injury
decision (§6) are agreed; §5.1/§5.2/§5.3 are built and shipped (CHANGELOG v0.7.55,
web-only). The §5.3 chip-linter is wired into the V4-W6 eval as the regression net —
the gate is 19/19 green with no chip-policy failures. One minor open question
remains (§8: single-option chips, leaning keep) — it doesn't gate the policy._

_Origin: the V4-W6 eval run (`onboarding-eval-2026-06-26T01-23.md`) surfaced a
chip that does nothing useful — the injury beat's `[Nothing right now | Skip]`,
two buttons that land the athlete in the same place. The question this doc
answers: is that one chip, or a class of them, and how do we find and stop the
rest without hand-checking every turn forever._

---

## 1. The problem

A chip should earn its place: it saves the athlete a decision or some typing, and
the options are choices the athlete can actually tell apart. Several onboarding
chips fail that test. The athlete has to first decide whether to tap or type, then
choose between buttons whose outcomes are indistinguishable to them. That is more
cognitive load than no chips at all.

The flagged case (`marathon-smoke`, and every fixture that reaches the injury
beat):

> Coach: Anything bothering you right now — or anything you've been managing
> recently that I should know about before building the plan?
> `[chips: Nothing right now | Skip]`

`Nothing right now` and `Skip` both mean "move past this" to the athlete. The only
difference is backend state, which they can't see.

---

## 2. Why this isn't one fix — chips come from two sources

The fix splits by where a chip originates, because the two sources need different
levers.

**Source A — app-guaranteed chips (code-owned).** Hardcoded in
[`chips.ts`](../src/server/telegram/onboarding/slots/chips.ts) and forced on by
`applyChipPolicy` in
[`guardrails.ts:504`](../src/server/telegram/onboarding/engine/guardrails.ts).
Finite set:

- `goal_type` → `A race | Personal goal with a date`
- `goal_distance` → `5K | 10K | Half | Marathon`
- `experience_tier` → `New to running | Run for fun | Some training | Experienced`
- injury beat (`INJURY_CHIPS`) → `Nothing right now | Skip`
- confirm / recap with no model chips → `YES_FIX_CHIPS` (`Looks right | Fix it`)

The model has **no say** over these. A prompt change can never reach them.

**Source B — model-generated chips.** The model attaches them for open questions.
The current instruction ([`extract-and-advance.ts:175`](../src/server/telegram/onboarding/engine/extract-and-advance.ts)):
"Populate it only for an open question where you want to offer a shortcut the app
cannot infer." Examples from the transcript: `[Not yet]` (time goal),
`[No tune-up races]`, the off-ramp's `[A race | Personal goal with a date]`. This
set is unbounded, so only a principle (prompt) governs it — you can't enumerate
it.

**Consequence:** the flagged `[Nothing right now | Skip]` is Source A. "Add MECE
prompting" cannot fix the very example that started this. Any solution has to hit
both sources, with the right tool for each.

---

## 3. Evidence — three failure modes

Walking the V4-W6 transcript, there are at least three distinct problems, not one.
None are currently caught by the eval (its 11 failures are about provenance
invariants and off-ramp convergence — chips are invisible to it).

**3.1 Non-distinct option pairs.** The flagged case. `Nothing right now` writes
`injury_status=none`; `Skip` leaves it `unknown`. Real to the backend (an unknown
means the coach won't assume the athlete is healthy), invisible to the athlete.
Two buttons, one perceived outcome. Source A (`INJURY_CHIPS`).

**3.2 Chips that don't match the question asked.** Worse, and it recurs. In
`injured`, `injury-skipper`, and `goal-change`, a yes/no shape confirm gets the
four experience-tier option chips:

> Coach: Strava shows roughly 4 days a week, long runs on Sunday, around 32 miles
> a week recently. **That about right?**
> `[chips: New to running | Run for fun | Some training | Experienced]`

The message wants yes/no; the chips offer four unrelated answers. Root cause is
structural: when the model batches the Strava confirm and sets
`asked_slot=experience_tier`, `applyChipPolicy` forces `SLOT_CHIPS[experience_tier]`
onto a message phrased as a yes/no. A mechanism bug (three fixtures), not a
one-off. Source A.

**3.3 Chips on messages that aren't questions.** In `general-fitness-offramp` and
`broad-non-running`, the `[A race | Personal goal with a date]` chips re-render on
goodbye / emoji turns:

> Coach: 👋😄 `[chips: A race | Personal goal with a date]`

Chips on a non-question read as broken. Source B (and the off-ramp path
specifically should suppress chips once it's a farewell).

---

## 4. The chip policy (the principle)

The single rule a chip must pass, and its corollaries. Once signed off this is the
canonical chip policy (this doc), and it's what the prompt (§5.2) and the eval
(§5.3) both encode.

**A chip exists only when it (a) saves the athlete a real decision or typing AND
(b) its options are choices the athlete can tell apart.**

Corollaries:

1. **No same-outcome pairs.** Two chips that land the athlete in the same place
   are one choice — collapse to one chip, or none. (Fixes 3.1.)
2. **Chips must answer the exact question in the message.** Never option-chips on a
   yes/no; never a chip set for a different slot than the one being asked.
   (Fixes 3.2.)
3. **No chips on a non-question.** Reflections, goodbyes, and the off-ramp
   farewell carry no chips. (Fixes 3.3.)
4. **A system-internal distinction is not a user-facing choice.** `none` vs
   `unknown` is for the backend, not for two buttons.

---

## 5. The fix, by source

**5.1 Code-owned chips (Source A) → hand audit.** Five sets and one policy
function. Small, finite, highest-traffic (every athlete hits all of them), and the
only way to reach 3.1 and 3.2. Enumeration is cheap *because the set is finite.*
Scope:

- Resolve the injury pair (§6).
- Fix `applyChipPolicy` so a yes/no confirm never inherits a slot's option chips
  (3.2). The likely shape: option-chips attach only when the message is an open
  ask for that slot, not when it's a batched confirm.
- Re-read the remaining three sets against §4.

**Status: implemented 2026-06-29** (commits `fff6e3e`, `5404fd9`; web, deployed).
Deterministic checks green (typecheck, lint, 1233 tests, build); eval **17/19**, no
regressions, +3 newly passing vs the prior 7/18. Landed: the single injury chip,
the `unknown` removal (soft-via-open — gate = answered OR asked; the recap→ask-injury
override records `asked`), and experience-as-its-own-question (Strava no longer
seeds it; `inferExperienceTier` removed; whole-history framing). Intake is now four
questions: event → Strava confirm → experience → injuries. The final fix shape
differed from the bullet above: rather than an `applyChipPolicy` heuristic, the
structural change (experience no longer seeded → always an open ask) plus
de-forcing yes/no chips on confirms (recap-only) carries 3.2 — but **not fully**
(see §5.2 residuals).

**5.2 Model-owned chips (Source B) → sharpen the prompt.** Replace the vague "a
shortcut the app cannot infer" with the §4 test stated plainly, plus an explicit
"no chips on a goodbye / off-ramp / reflection turn" (3.3). Plus three
model-adherence gaps the §5.1 eval surfaced (transcripts in
`onboarding-eval-2026-06-29T17-26.md`):

- **Residual 3.2** — the model still labels the Strava confirm `ask`+`experience_tier`,
  putting the four tier chips on a "that right?" yes/no (confirm-loop-replay,
  goal-change). Fix: the Strava confirm and the experience ask are SEPARATE turns —
  confirm days/long-run with `next_action='confirm'` and NO `asked_slot`; ask
  experience as its own later turn. (Possibly a small code backstop too.)
- **Order** — David wants the Strava confirm BEFORE experience (no gotcha), but the
  model does experience-first ~half the time. Strengthen the four-topic order in
  FLOW_RULES. The gotcha is already structurally gone, so this is a preference.
- **Injury dodge** — under soft-via-open the coach should accept a dodge and move on,
  but it badgered 3× in injury-skipper (a regression from removing `[Skip]`). Add a
  rule: ask the beat once; if the athlete declines/dodges, accept it and proceed.

The principle is the only lever here; the set is unbounded. §5.3's chip-linter keeps
these from regressing once fixed.

**Status: shipped 2026-06-29** (commit `00b3bb5`; web). The chip instruction now
states the §4 test plainly and forbids chips on a goodbye / off-ramp / reflection
turn; FLOW_RULES splits the Strava confirm and the experience ask into separate
turns (closing residual 3.2), strengthens the four-topic order, and tells the coach
to accept an injury dodge and move on (closing the injury-dodge residual).

**5.3 Eval → regression net.** The harness already parses `[chips: …]` out of
transcripts, so a chip-linter is cheap and is what keeps Source B from drifting
back after the prompt change. Assertions to add:

- chips present on a non-question / terminal turn → fail;
- a chip pair whose options map to the same outcome → fail;
- option-chips on a yes/no-phrased message → fail;
- chips whose values don't round-trip to the slot being asked → fail.

Going chip-by-chip alone misses Source B (unbounded) and stops no regressions.
Prompting alone can't reach Source A (where the flagged case lives). The split is
the point.

**Status: shipped 2026-06-29** (CHANGELOG v0.7.55; web; unit-covered in
`engine/__tests__/chip-linter.test.ts`). `checkChipPolicy`
(`engine/__evals__/assertions.ts`, folded into `checkGlobalInvariants`, so it runs
on every fixture) implements all four, deterministically over the rendered
transcript — no model calls. How each is detected robustly:

- **non-question / terminal** — a "no `?`" rule over-fired on the legitimate
  chipped turns that *state* rather than ask (an imperative ask, "Go check the site
  and let me know."; a recap that closes "…building your plan now." + Looks
  right / Fix it). So the check fires only on a genuinely **non-soliciting** turn:
  emoji/symbol-only (the 👋😄 goodbye), a reflection-only mirror, or a farewell
  sign-off with no `?`. (Caught two real false-positive shapes in the §5.1 eval;
  recalibrated, both now pass.)
- **same-outcome pair** — two chips in one set sharing a value or a label
  (deterministic; the perceptual-but-distinct `none`/`unknown` case is structurally
  gone via §6's single-chip injury set).
- **option-on-yes/no** — a confirmation tell in the message ("…that right?",
  "…match?") paired with chips that aren't a pure yes/no set. Tight on the tell so
  open asks (which legitimately carry option chips) and the check-back offer don't
  trip it.
- **round-trip** — the rendered set is matched to an app-guaranteed set (chips.ts)
  by label; each value must then `coerceFill` to that slot (enum-literal sets) or
  match the canonical value (the prose sets, which round-trip via the model).

The linter operates only on the onboarding `v3:`-prefixed chips; the post-plan
next-actions keyboard and other inline keyboards are out of its scope.

---

## 6. The injury-beat decision (resolved 2026-06-26)

**Decision: collapse to a single chip, and drop the `unknown` state.**

- The chip set becomes one chip: `Nothing right now` → `injury_status = none`
  (stated). The `Skip` chip is removed.
- The athlete answers the beat explicitly: tap `Nothing right now` (none), or
  describe an injury in text (active / monitoring / past). No button records
  "didn't say."
- `unknown` is no longer a *stored* `injury_status` value. (§5.1 decides whether
  it's dropped from the enum outright or kept only as the transient "not yet
  answered" sentinel — i.e. the slot simply stays open until answered.)

**What this changes (and a flag).** Today the injury beat is a *soft* gate, and
the softness is implemented by exactly the path we're deleting: `Skip` writes
`injury_status = unknown`, a non-null "answered" value that satisfies
`isV3OnboardingComplete` and ships a conservative plan
([`slot-state.ts:324`](../src/server/telegram/onboarding/slots/slot-state.ts) —
v3 decision #6). Remove `Skip` + `unknown` and that mechanism is gone.

The coherent replacement, and what this doc assumes unless David says otherwise:
**keep the beat soft, but represent "not answered" as the slot being open, not as
a stored `unknown`.** A genuine non-answer (the athlete ignores or dodges the
question) leaves `injury_status` open; if onboarding otherwise completes, the plan
defaults conservative — the same outcome as today, minus the stored value and the
redundant button. The alternative is a *hard* block (onboarding can't finish until
the beat is answered); it risks a re-ask loop when an athlete won't engage and can
pressure a false "none," so it isn't the default here.

> **FLAG for David:** confirm soft-via-open (above) vs a hard block. Everything in
> §5.1 follows from this.

**Safety property preserved.** The `mergeFills` backstop that stops the model
inferring injury-freeness still holds: a non-stated `none` no longer downgrades to
a stored `unknown` — it leaves the beat *open* instead. "Never infer no-injury
from silence" is unchanged.

---

## 7. Work plan (section by section)

Proposed order once the policy (§4) is signed off:

1. **§4 + §6** — agree the policy and the injury-beat decision. (This session.)
2. **§5.1** — hand audit + fix the code-owned sets, including the
   experience-chips-on-confirm bug (3.2). Web-only; push to Vercel. **✅ done 2026-06-29.**
3. **§5.2** — sharpen the chip instruction in the prompt; close the three §5.2
   residuals the §5.1 eval surfaced (residual 3.2, order, injury-dodge). **✅ done
   2026-06-29** (commit `00b3bb5`).
4. **§5.3** — add chip assertions to the V4-W6 eval harness. **✅ done 2026-06-29**
   (CHANGELOG v0.7.55).
5. Flip this doc to signed-off (it's the chip-policy source of truth); add a
   one-line pointer from `ONBOARDING_V4.md` and `SPEC.md`; log in `CHANGELOG.md`.
   (`ONBOARDING_V3.md` is stale — don't write back into it.) **✅ done 2026-06-29.**

---

## 8. Open questions

- Single-option chips (`[Not yet]`, `[No tune-up races]`) — keep as one-tap
  "none/skip" affordances, or drop? They pass §4 (a tap saves typing) but add a
  consistency question. Leaning keep.
- ~~Does fixing 3.2 in `applyChipPolicy` need a matching prompt nudge…?~~
  **RESOLVED (§5.1 eval): yes.** The structural fix alone didn't fully close 3.2 —
  the model still mislabels the Strava confirm, so §5.2's prompt nudge (separate
  confirm/ask turns) is required, with §5.3's chip-linter as the net.
