# Calendar-confirm — tap-to-commit for future-day plan changes

> Authoritative design record for the calendar-confirm feature (designed 2026-06-08). This file is the source of truth until the behavior is folded into a §3.x section of `SPEC.md`. A `Specs/CHANGELOG.md` entry should point here (§2 governance).

## Why

The calendar goes stale because the path from "we agreed to a change" to "the plan actually changed" runs through three LLM-held steps, each of which can fail: the coach has to (1) detect that the athlete agreed, (2) translate the agreement into a faithful, schema-valid edit, and (3) tell the athlete honestly that it saved. (A separate, unrelated cause is Google's external-ICS poll latency — out of scope here; that's the ICS-vs-OAuth question.)

This paradigm takes all three out of the model and makes the commit a deterministic, user-driven transaction: the coach proposes in prose and stages a candidate; the athlete commits with an unambiguous tap; code applies it and confirms. The coach's job shrinks to proposing well and producing the candidate edit. Agreement can't be misread, the edit can't drift from what was shown, and the confirmation can't be a lie — because code emits it only after the apply succeeds.

It is orthogonal to the ICS-vs-OAuth decision: the calendar still renders `current_version_id`, so a promoted change shows up the same way it does today (and would trigger a direct write if/when OAuth direct-write lands). This fixes the write-through half (A) regardless of how the sync half (B) is eventually solved.

## Decisions (locked 2026-06-08)

- **Apply model: B-lite.** A proposed change is written immediately as a non-active candidate `plan_versions` row. The calendar does not move until the athlete taps Yes, which promotes the candidate to active. No re-run of the agent on confirm; no separate mutation schema.
- **Threshold: any change touching a day beyond today.** A change that only concerns today stays plain prose with no plan edit and no button. A change that touches any future day stages a candidate and shows the confirm button.
  - "I ran 2 instead of 4 today" → no plan edit, no button.
  - "You ran 2 instead of 4, so let's bump tomorrow's mileage" → candidate + button.
  - In practice this means every edit to `marathon_training_plan.json` routes through propose→confirm, because the plan is the forward schedule. Today-only adjustments are handled as a prescription in prose, not a plan-JSON edit.

## The flow

1. **Propose (worker, message 1 + message 2).** The coach proposes the change in its own voice (message 1, natural prose). If the change touches a future day, it edits `marathon_training_plan.json` — but the worker writes that edit as a **`proposed`** `plan_versions` row and leaves `current_version_id` untouched. When a proposed candidate exists for the run, the worker sends a second message: a terse inline keyboard, e.g. `Update your calendar? [Yes, update] [No, leave it]`.
2. **Pending state.** The candidate version + a short token is the pending change, referenced by callback data. One outstanding proposal per athlete: a new proposal supersedes/expires the previous unresolved one (its message is edited to "expired"). Proposals expire on their own after a window (default: end of the affected week, hard cap ~72h — to finalize).
3. **Confirm (Vercel callback handler, tap Yes).** Re-validate the candidate against the *current* active version (it may be stale — the day may already be run per Strava, or the plan moved since). If still applicable, promote it to active (flip `current_version_id`), edit the button message to `✓ Updated — moved to Wed`, and stop. Deduped on `callbackQuery.id`. No agent run.
4. **Deny (tap No).** Discard the candidate, edit the message to `Left as-is.`
5. **Confirmation.** Emitted by code on a successful promote (the edited button message is the confirmation). The coach never claims a save in its prose — honest by construction.

## What changes, where

- **DB / migration.** `plan_versions.status` gains `proposed`. `plans` gains `proposed_version_id` (nullable), `proposed_token` (short, for callback_data), and `proposed_expires_at` (nullable). Split the existing `record_plan_edit` RPC into:
  - `propose_plan_edit` — insert a `proposed` version, set the proposed pointer/token/expiry, do **not** repoint `current_version_id`; supersede any prior outstanding proposal.
  - `promote_proposed_version` — set the proposed version active, repoint `current_version_id`, clear the proposed pointer/token/expiry. Idempotent (a non-matching/cleared/expired token is a no-op with a clear "not applicable" result, not an error).
  - `discard_proposed_version` — clear the proposal (no-op if already cleared).
- **Worker (`worker/plan-version.ts`).** `persistPlanEdit` becomes the propose path: a changed, schema-valid `marathon_training_plan.json` is written via `propose_plan_edit`, not activated. Surfaces that a candidate exists (+ its token) so the send layer can attach the keyboard. Keeps the C drop+alert backstop.
- **Worker (`worker/run-agent.ts` / `worker/send.ts`).** When a candidate was staged this run, send message 2 with the inline keyboard after the coach's prose. Keyboard build reuses grammy `InlineKeyboard` as onboarding does.
- **Bot (`src/server/telegram/bot.ts`).** New callback routes `cal:y:<token>` / `cal:n:<token>`, mirroring the existing `next:*` handlers. Yes = re-validate + `promote_proposed_version` + edit message; No = `discard_proposed_version` + edit message. Reuse the `callbackQuery.id` dedup from `next:adjust`.
- **Validation hook (stage 3).** PostToolUse hook validates the candidate edit at propose time (in-loop), so a malformed candidate is fixed before the run ends rather than staged broken. (SDK 0.3.154 supports `PostToolUse` with `additionalContext` / `decision:'block'`.)
- **Backstop (C).** A candidate that still fails validation on the propose path drops with a David alert — prompted separately. The hook prevents; C catches.
- **`worker/prompts/coach.md`.** Rewrite "Changing the plan — the calendar follows it": the coach proposes in prose and edits the plan to *stage* a change; the athlete gets a confirm button; on Yes it becomes active. Remove "it reaches their calendar on the next refresh" and the implication that an edit is immediately live. Define when to propose (touches a future day) vs prose-only (today). The coach must not say a change is saved/locked — the button + system confirm own that.

## Gotchas to design for

- **Voice / button fatigue.** Only material future-day changes get a button; today-only stays prose. Keep message 2 terse and system-like — it should read official, not chatty. Watch the §3 copy rules on both messages.
- **Staleness.** Re-validate on tap, never blind-apply a candidate built days earlier. Expire unresolved proposals.
- **One outstanding at a time.** A new proposal supersedes/expires the prior unresolved one.
- **Resolve the message on tap.** Edit the button message to a ✓/✗ resolved state so it can't be re-tapped — this is both the "can't get lost" feeling and the idempotency guard.
- **Cross-runtime split.** Propose happens in the worker (Fly); the tap lands at the webhook (Vercel). B-lite keeps the tap cheap on Vercel (pointer flip + message edit, no agent run).

## Out of scope

- Google ICS poll latency (B) and the OAuth-direct-write question — separate track.
- The ICS render path is unchanged; it still renders `current_version_id`.

## Open questions to finalize

- ~~Expiry window (end-of-week vs fixed ~72h vs both).~~ **Decided (2026-06-09): both** — `min(end of the week containing the earliest changed future day, athlete tz; propose-time + 72h)`. No changed future day → 72h. Built as `proposalExpiry` in `worker/plan-version.ts`.
- Exact button + confirm copy (voice pass). All of it is draft as of the 2026-06-09 cutover: the bot-side resolved messages, the `Update your calendar?` keyboard text + button labels, and the superseded-keyboard edit.
- ~~Does "No" offer a tweak path, or just dismiss?~~ **Decided (2026-06-09): just dismiss** ("Left as-is."). Replying to the coach in chat is the tweak path — no extra button, no nudge line.
- Does promote send any message beyond editing the button message? (Lean: no — avoid noise.)

## Suggested build sequence

1. C (backstop + the `persistPlanEdit` outcome enum) — already prompted and built.
2. Migration + RPC split (`proposed` status, `proposed_version_id`/`proposed_token`/`proposed_expires_at`, `propose_plan_edit` / `promote_proposed_version` / `discard_proposed_version`) — **built 2026-06-09** (CHANGELOG v0.7.26; plus `discarded` status and `proposed_message_id`, for the supersede/expiry message edits). Re-validation at tap = base-version + expiry only — no Strava fetch at the webhook.
3. Worker propose path + PostToolUse validation hook — **built 2026-06-09** (the cutover deploy, CHANGELOG v0.7.28; `worker/plan-version.ts` + new `worker/plan-edit-hook.ts`).
4. Send-side keyboard (message 2) + bot `cal:y|n` callback handler with re-validate, promote/discard, message edit, dedup — **bot half built 2026-06-09** (`handleCalendarConfirm`); **message-2 keyboard built 2026-06-09 with the cutover** (`sendCalendarConfirm` / `resolveStaleProposalMessage` in `worker/send.ts`).
5. `coach.md` rewrite (propose-not-activate; when to propose; never claim saved) — **built 2026-06-09** (the cutover deploy).
6. Expiry + one-outstanding handling (folded into 2 + 4) — **built 2026-06-09**. Expiry is passive — enforced at tap, no sweep cron — and the window is `min(end of affected week, 72h)` (see the closed open question below). Error/budget-stopped runs stage the candidate but suppress the keyboard, so the fallback message never pairs with a confirm button.

Steps 3 + 4's send half + 5 are the cutover and landed in one fly deploy (2026-06-09): the moment edits stopped activating, the coach stopped claiming saves and the button existed. Remaining: David's voice pass on all the draft copy.

Tests at each step: RPC propose/promote/discard/idempotency; worker stages-not-activates; callback promotes/discards + dedups; coach.md behavior in `worker/__tests__`. Worker changes → `git push` + `fly deploy`; web/bot changes → `git push`. Confirm the tree is only your change before deploy (§10).
