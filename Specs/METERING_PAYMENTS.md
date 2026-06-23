# Metering & Payments Plan (v1)

**Status:** proposed — pending David's review before SPEC §3.11 is rewritten to point here.
**Date:** 2026-06-04
**Supersedes:** the "deferred" half of SPEC §3.11 (balance + decrement + $0 gate; markup + payments). The built half (ledger `agent_runs`, rollup views) stands unchanged and feeds this.

This is the source-of-truth design for how a friend's usage is metered, how they pay, and how the bot handles running out. It builds on what's already shipped: per-run cost lands in `agent_runs.cost_usd`, rolled up by `athlete_cost_daily` and `athlete_cost_rollup`. Those views are the burn-rate input for everything below.

---

## 1. Decisions (locked with David, 2026-06-04)

| Dimension | Decision |
|---|---|
| Free credit | **$5, once per new friend at signup.** Permanent policy, not a launch promo. |
| Credit basis | **Dollars, drawn down at 1.5× raw run cost.** Each run debits `cost_usd × 1.5`. |
| Buffer transparency | **Disclosed.** Help text says credits aren't 1:1 with tokens — they cover our costs (fees, hosting), not profit. |
| Payment rail | **Stripe Checkout via a link the bot sends.** Not Telegram Stars. (§3) |
| Top-up amounts | **Presets $10 / $25 / $50, default $25.** |
| Auto-reload | **Opt-in, off by default.** When on: balance **< $3 → charge $25** off-session. |
| At $0 | **Finish the in-flight run, then hard block.** Next run refused at dequeue with a top-up prompt. |
| Low-balance warning | **Two messages:** heads-up at ~1 week of runway, final at $0. |
| Comp | **Per-friend `comped` flag.** Billing skipped entirely (David, family, anyone). |
| Surface | **Telegram-first.** `/balance` and `/buy` commands + help-menu entries; payment completes on Stripe's hosted page in the browser. |
| Pause | **`/pause` (optional timed) + `/resume`.** Suspends proactive daily check-ins and the spend they cause while a friend is away; ad-hoc messages still answered. (§10) |
| Auto-pause | **5 days of athlete silence → auto-pause daily check-ins + one static notice with a resume button.** Any inbound message or the button resumes. Inbound-messages-only signal; no weekly-downgrade tier. Build-first candidate — ships the pause primitive standalone. (§10.5; locked 2026-06-12, **shipped 2026-06-22 — window tightened 10→5 at arming**) |

---

## 2. Economics

Balance is denominated in **real dollars the friend paid**. A run that costs us `$cost_usd` of model time debits `cost_usd × 1.5` from the balance. So $25 of credit covers ~$16.70 of actual model cost; the other ~$8.33 is the buffer.

**Planning number (measured 2026-06-22, trailing 14 days, friends only — David's dev/testing usage excluded; 6 athletes, 71 athlete-days, 192 runs): raw ~$0.53/athlete/day → billed ~$0.80/day.** Mean $0.53 / median $0.57 raw (billed $0.80 / $0.85), spread $0.25–$0.67/day across the six. **David is excluded on purpose** — at $1.09/day raw he's a dev/tester outlier who pulled the all-athlete mean ~17% high; the friends are the right planning basis for what a real paying user costs. This replaces the stale 2026-06-05 figure (raw $0.85 / billed $1.28). Prompt caching is confirmed working — **83% of input tokens are cache reads** — which closes §13's open thread (a). (Still above the original SPEC §2.1 estimates of $0.08 hybrid / $0.24 Opus-heavy — that table is stale; the runway numbers below are authoritative.)

| Amount | Runway at $0.80/day billed |
|---|---|
| $5 (free grant) | **~6 days** |
| $10 | ~13 days |
| $25 (default top-up) | **~4.5 weeks** |
| $50 | ~9 weeks |

Per athlete per month: **~$16 raw, ~$24 billed.**

Takeaways:
- **This is a ~$24/mo product** — down from the ~$39/mo the testing-era number implied (and ~$28/mo before David was pulled out), but still not a top-up-twice-a-year one. A paying friend tops up roughly monthly, so auto-reload stays the sane default to *recommend* (still opt-in per the locked decision).
- **The $5 grant buys ~6 days** — still a taste, not a full training week. Flagged for David: accept it as a deliberate short taste or raise the grant. ($5 stands until he says otherwise.)
- **Free friends still cost real money, just less.** At ~$16/mo raw, every comped/free friend is ~$16/mo out of pocket — ~$320/mo if 20 ride free (was ~$520 at the old burn). The earlier "confirm caching is actually happening" caveat is **closed**: caching is live at an 83% cache-read share, so $0.53 is the tuned number, not an un-optimized one. The remaining cost lever is Sonnet-for-daily routing, not caching.
- **The buffer clears infra comfortably.** 0.5× on $0.53/day collects ~$8/mo per paying athlete vs ~$1 of Stripe fees per monthly top-up — hosting amortization covered.
- **Re-measure again after more real traffic and once auto-pause (§10.5) trims inactive-friend spend.** The query behind this update (mean/median billed-$/day from `athlete_cost_daily`, excluding test athletes *and* David's athlete id) is reproducible; re-sanity-check the $5 grant and $25 default then.

---

## 3. Why Stripe, not Telegram Stars

Telegram policy: digital goods and services sold *inside* Telegram via the Bot Payments API must be sold in **Telegram Stars** (currency `XTR`). Third-party providers (Stripe, etc.) through that API are reserved for *physical* goods. Coaching credits are a digital service, so an in-window Bot-Payments purchase would be forced onto Stars.

Stars carry Telegram's revenue share **plus** the Apple/Google in-app-purchase cut — creators typically net **50–70%** of face value. On a near-pass-through, cost-recovery product that's a 30–50% tax that would exceed the entire buffer. Stripe is ~2.9% + $0.30 (4.1% on a $25 charge).

**The compliant pattern we use:** the bot sends a normal `https` **Stripe Checkout link**. Payment happens on Stripe's hosted page in the browser — outside Telegram's payment rail — so the digital-goods rule doesn't apply. The friend leaves the Telegram window for ~20 seconds and comes back; the bot confirms via webhook.

**Mini App (deferred, optional):** a Telegram Mini App webview wrapping the same Stripe Checkout would keep it feeling in-app. It's nicer UX but adds an Apple/Telegram policy gray area (in-app webviews selling digital goods). For 5–25 friends the enforcement risk is near zero, but the plain link ships first and carries no policy risk. Revisit the Mini App only if the browser hop proves to be real friction.

---

## 4. Data model

**Built 2026-06-22 — migration `20260622000000_metering_credits.sql`.** The draw-down/Stripe/auto-reload columns exist but stay unused until their later steps.

```
athlete_credits        (athlete_id PK/FK, balance_cents int not null default 0,
                        comped bool not null default false,
                        stripe_customer_id text,            -- set on first Checkout
                        auto_reload_enabled bool not null default false,
                        auto_reload_threshold_cents int not null default 300,   -- $3
                        auto_reload_amount_cents int not null default 2500,     -- $25
                        default_pm_id text,                 -- saved card for off-session
                        low_balance_warned_at timestamptz,  -- dedupe the ~1wk heads-up
                        updated_at timestamptz not null default now())

credit_ledger          (id PK, athlete_id FK, kind text not null
                          check (kind in ('grant','topup','debit','refund','adjust')),
                        amount_cents int not null,          -- signed: +credit, -debit
                        balance_after_cents int not null,
                        related_run_id FK→agent_runs nullable,  -- for debits
                        stripe_payment_intent text nullable,    -- for topups/refunds
                        note text, created_at)
```

Indexes: `credit_ledger(athlete_id, created_at desc)` for per-athlete history, plus a **partial unique index `credit_ledger(athlete_id) where kind='grant'`** — the DB-level guard that makes the signup grant idempotent (one grant per athlete, ever). RLS is enabled with no policies on both tables, matching the rest of the schema (all access is via the service-role key).

- **`athlete_credits` is the live balance; `credit_ledger` is the append-only audit.** Every mutation writes both in one transaction. Balance is reconstructable from the ledger — the table is a cache for the hot path.
- Cents, not dollars, everywhere. No floats on money.
- `comped = true` short-circuits all billing: no debit, no warning, no gate.
- This reuses David's familiar shape — a never-overwritten log (`credit_ledger`) plus an overwritten latest-state (`athlete_credits`).

**The $5 grant** is a single `kind=grant` ledger row (+ matching balance) written at **onboarding completion** (`finishOnboarding` → `phase='complete'` in `src/server/telegram/onboarding/engine/router.ts`), **not** at athlete-row creation — the athlete row is created earlier, at the Telegram link-handshake step, before onboarding finishes. It's written by the idempotent `grant_signup_credit(athlete_id, amount_cents default 500)` RPC (ledger row + balance bump in one transaction; a no-op if a grant already exists), which the migration's backfill reuses to grant every existing athlete exactly once. The TS entry point is `grantSignupCredit()` in `src/server/billing/credits.ts`.

**Comp roster at launch (2026-06-22):** only David is comped — both his real athlete (`telegram_chat_id = 8940829310`) and the negative-chat test/group row. The 6 friends (Anjie, Brenden, Chase, Nathan, Kiran, Ian) are metered with the $5 grant and `comped=false`, so step 2's draw-down exercises against live traffic. Flip `comped` per friend from the admin console when the free era ends.

---

## 5. Draw-down + the $0 gate

**Built 2026-06-22 (step 2) — migration `20260622000001_metering_drawdown.sql`.** Filled the `// TODO(#12)` hook in `worker/run-agent.ts`. Item 3 (auto-reload interception) stays deferred to step 6.

1. **Decrement (post-run):** after the agent run persists `agent_runs`, debit `round(cost_usd × 1.5 × 100)` cents — a signed-negative `kind=debit` ledger row referencing the run **and** a balance decrement, in one atomic transaction **keyed to the persisted run** (the `debit_run_credit(athlete_id, run_id, amount_cents)` RPC). This is deliberately **not** the same transaction as the `agent_runs` insert: decoupling them means a debit hiccup can never roll back the run record. The debit references the already-persisted run and is best-effort (a failure logs, never blocks delivery; the ledger reconciles). Skipped entirely if `comped`. The 1.5× markup + rounding live once in TS (`src/server/billing/pricing.ts` → `billedCents`), shared by worker and web — the RPC takes already-computed cents, so the number is never duplicated in SQL. Idempotent in the DB: a partial unique index `credit_ledger(related_run_id) where kind='debit'` makes a re-persisted *same* run a no-op (the twin of the signup-grant guard). A job *retry* spawns a new run → a new, correct debit; only re-debiting the same run is blocked. **Successful runs only (added 2026-06-23):** the debit is skipped whenever the run errored — a transient-overload failure on the final attempt, a budget stop (`error_max_budget_usd`), or a crash all ship a fallback message rather than a real coaching answer, so the athlete isn't charged even when the failed attempt burned tokens (`worker/run-agent.ts` gates `chargeRun` on `!runError`). Intermediate retryable attempts never reach the debit at all: a transient Anthropic overload (529 / 429 / 5xx, classified by `isRetryableAgentError` in `worker/retryable.ts`) throws back into the job-queue backoff *before* the run is persisted, so only the final attempt records an `agent_runs` row — and it charges only if it succeeded.
2. **Gate (pre-run, at dequeue):** when the worker pulls a `daily_checkin` or `tg_message` (adhoc) job, check balance **before** running. If `balance_cents <= 0` and not `comped`, **don't run** — mark the job terminally blocked (complete-with-marker: set `completed_at` + `last_error='blocked: insufficient_credit'`, so `claim_next_job`'s `completed_at is null` filter never re-claims it and there's no retry/backoff; §11 admin reads the reason from `last_error`), alert David, and send the friend the final top-up message (§8). The in-flight run that drove them to $0 always completes; the *next* one is what's refused. **The whole gate is held behind `BILLING_GATE_ENABLED` (env, default off)** until the top-up path (`/buy`, the §8 buttons) exists — while off, a $0 non-comped athlete still RUNS and only the draw-down (item 1) meters them silently; flipping the flag on starts the blocking + alerting + messaging together. The gate **fails open**: any error reading the balance, or a missing billing row, allows the run and alerts David — a friend is never denied coaching by a billing-cache hiccup.
3. **Auto-reload interception (deferred to step 6):** the gate first checks whether auto-reload is on and the balance is below threshold; if so it attempts the off-session charge (§7) and, on success, proceeds. Only a failed/absent reload blocks.

Edge — overshoot into negative is allowed: a single expensive run can push a tiny positive balance negative. That's fine — the in-flight run finishes and lands the balance slightly negative; the ledger carries the true number and the next top-up reconciles. The debit never clamps. We never *start* a run from `<= 0` once the gate is enabled.

---

## 6. Stripe Checkout flow (`/buy`)

1. Friend runs `/buy` (or taps the heads-up/final-warning button). Bot replies with three inline buttons: **$10 · $25 (default) · $50**.
2. On tap, the **bot server** (Next.js API route) creates a Stripe **Checkout Session**:
   - `mode: payment`, single line item for the chosen amount.
   - `client_reference_id = athlete_id` (attribution).
   - `customer` = the athlete's `stripe_customer_id` (create on first purchase, store it).
   - `payment_intent_data.setup_future_usage = 'off_session'` **only if** the friend is enabling auto-reload in this flow — this is how we save the card without a separate SetupIntent.
   - `metadata: { athlete_id, kind: 'topup' }`.
3. Bot sends the `session.url` as a plain link. Friend pays on Stripe's page.
4. **Stripe webhook** (`checkout.session.completed`) → verify signature (raw body) → `client_reference_id` is the `athlete_id` → credit the **net or gross?** Decision: **credit the gross amount the friend paid** ($25 → $25 of balance, read from `session.amount_total`). The Stripe fee is absorbed by the buffer, not deducted from their balance — simpler and friendlier. Write `kind=topup` ledger row + bump balance (and clear `low_balance_warned_at`, §8), idempotent on `(payment_intent, kind)` (per-kind, not the PI alone — see the step-3 note below).
5. Bot sends a confirmation to Telegram ("$25 added — you're at $X, about N weeks at your pace.").

Use **dynamic Checkout Sessions, not pre-made Payment Links** — we need per-athlete attribution, variable amounts, and conditional card-saving, none of which static links handle cleanly.

**Built 2026-06-23 (step 3).** One parameterized RPC `apply_stripe_credit(athlete_id, payment_intent, amount_cents, kind)` writes both topup (+) and refund (−) — mirror images, so one function (not two), mirroring the grant/debit precedent's atomic ledger-row + balance-bump shape. The create-session route is `POST /api/billing/checkout`; the webhook is `POST /api/stripe/webhook` (raw-body signature verify against `STRIPE_WEBHOOK_SECRET`). `setup_future_usage` is **deferred to step 6** (auto-reload) — step 3 never saves a card.

Webhook idempotency: a replayed event must not double-credit. The DB guard is a **partial unique index on `(stripe_payment_intent, kind)`** — keyed per-kind, *not* on `payment_intent` alone, because a topup and its later refund share the same `payment_intent`; a single-column unique would wrongly reject the refund. (Corollary: at most one refund row per charge — see the §11 partial-refund note.) This is the DB-level twin of the grant/debit guards.

---

## 7. Auto-reload (opt-in)

- **Off by default.** Offered as a checkbox/secondary button during a `/buy` flow and toggleable later from the help menu. Never silently enabled.
- **Enabling** requires a saved card. We capture it by setting `setup_future_usage = 'off_session'` on the *next* Checkout the friend completes, then store the resulting `payment_method` id as `default_pm_id` (and the `customer` id). No card on file ⇒ auto-reload can't be turned on; the bot says so and points to `/buy`.
- **Trigger:** at the pre-run gate, if `auto_reload_enabled` and `balance_cents < auto_reload_threshold_cents` ($3), create an **off-session PaymentIntent** for `auto_reload_amount_cents` ($25) against `default_pm_id`. On success → credit + `kind=topup` ledger row + proceed with the run + a quiet "auto-reloaded $25" note. On failure (card declined, SCA required) → fall through to the $0 gate behavior and tell the friend their auto-reload failed with a `/buy` link.
- **$3, not "1 week of runway":** David's call. Simpler and predictable. Note that at measured burn (~$0.80/day billed, §2) $3 is only ~3.8 days of runway — the trigger fires with a few runs to spare rather than a comfortable margin. Acceptable (worst case defers one run to a manual top-up), but if average cost rises further, bump the threshold before friends start hitting the gate with auto-reload on.

---

## 8. Warnings & burn-rate

**Burn rate** = recent billed cost per day, read from `athlete_cost_rollup` (×1.5 to convert raw→billed). New athletes with <3 days of history use a default of $0.80/day (the measured friends-only average, §2 — keep this constant in one place and update it when the average moves). **Runway days** = `balance / billed_per_day`.

> **Built 2026-06-23 (step 4) — `src/server/billing/burn-rate.ts`.** The helper uses the rollup's **7d window** (`cost_usd_7d / 7`), not the 14-day window this section originally specified: `athlete_cost_rollup` only exposes 7d/28d, and adding a 14d column is a migration the step didn't warrant. The 7d window is more recent-weighted, which is fine for a runway estimate. The `$0.80/day` default lives as `DEFAULT_BILLED_PER_DAY_CENTS = 80` in that file (the one place, per §2). `runwayLabel()` renders "about N days / about a week / about N weeks." If a 14d basis is ever wanted, add `cost_usd_14d`/`runs_14d` to the rollup view and switch the helper.

- **Heads-up (~1 week left):** when projected runway crosses ~7 days, send one message: "About a week of credit left (~$X). Top up when you like — /buy." Set `low_balance_warned_at` to dedupe; clear it on any top-up so the next cycle warns again.
- **Final (at $0):** sent by the gate when a run is blocked. "You're out of credit, so I've paused. Add credit to pick back up — /buy." Includes the preset buttons.
- Comped friends get neither.
- Both messages must read like a person wrote them — short, no "Great news!", no exclamation-stacking. See CLAUDE.md copy rules.

---

## 9. Telegram surface

Commands, all registered in the bot command menu (alongside `/checkin`, `/edit_profile`) and described in `/help`:

- **`/balance`** → "$18.40 left — about 5 weeks at your pace." Dollars + estimated time remaining (burn-rate calc from §8). If comped: "You're on the house — no credit needed." If paused: prepend the paused state (§10). If auto-reload on: append "Auto-reload: on (+$25 at $3)."
- **`/buy`** → the preset-button flow (§6). Also the entry point to toggle auto-reload.
- **`/pause`** / **`/resume`** → suspend and restore proactive daily check-ins (§10).

Help-menu block should state plainly: credits cover model usage; they're not 1:1 with tokens because there are payment and hosting costs on top; the markup exists to cover costs, not to make money. One or two sentences, David's voice.

Payment itself happens on Stripe's hosted page via the link — the only step that leaves Telegram. Everything else (checking balance, choosing an amount, getting confirmation, managing auto-reload) stays in the chat.

---

## 10. Pause / vacation mode (`/pause`, `/resume`)

Lets a friend stop proactive daily check-ins while away — vacation, travel, an injury layoff — so they don't burn credit on messages they won't read. This is cost-of-no-value control: the reason it lives in this doc.

- **`/pause`** — suspends the proactive daily check-in indefinitely. Optional timed form: `/pause 7` (days) or `/pause until Aug 15` → auto-resumes that day. Bot confirms with the resume date, or "paused until you run /resume."
- **`/resume`** — clears the pause; daily check-ins resume on the next scheduled day. Bot confirms.
- **While paused:**
  - The daily enqueue (SPEC §3.5/§3.7 — the Vercel cron that inserts `daily-{athlete_id}-{date}` jobs) **skips paused athletes**, so daily spend goes to zero. This filter is the load-bearing change; the command is a thin wrapper over it.
  - Low-balance warnings and the auto-reload check are suspended too — nothing is burning, so there's nothing to warn about or reload for.
  - **Ad-hoc messages still work.** If the friend messages the bot it answers and debits normally (user-initiated = getting value). It does *not* silently flip daily back on; it appends a light "daily check-ins are still paused — /resume to switch them back on." Keeps state predictable.
- **Auto-resume:** a daily cron pass resumes any athlete whose `pause_resumes_at` has passed and sends a short welcome-back message.
- **State lives on `athletes`, not `athlete_credits`** — it's coaching-loop state, not billing state. `paused_at timestamptz null` (null = active) and `pause_resumes_at timestamptz null` (null = indefinite). The enqueue cron's active-athlete predicate gains `paused_at is null`.
- **Plan continuity:** pausing suppresses messages only; it does not edit the plan. On resume the bot picks up at the current calendar date, which may be mid-plan — the welcome-back message should orient the friend ("you're in week 6, long run Sunday") rather than pretend no time passed.

---

## 10.5 Auto-pause on inactivity (build-first candidate)

**Decided with David, 2026-06-12. Shipped + armed 2026-06-22** (live: `src/server/telegram/pause.ts`, the `daily-checkin` cron, migration `20260614000000_athlete_pause_columns.sql`). Standalone-buildable and shipped *first*, ahead of the rest of this doc: it introduces the pause primitive — the `paused_at` column, the enqueue skip filter, and a resume path — that §10's manual `/pause` later reuses. Nothing here depends on credits, Stripe, or the balance gate.

> **Arming note (2026-06-22):** the inactivity window was tightened from the originally-locked **10 days to 5 days** when the feature went live (`INACTIVITY_WINDOW_DAYS = 5` in `pause.ts`), and the notice copy was finalized (below). There is no dry-run env flag in prod; the daily cron pauses for real. The numbers throughout this section read **5 days**.

**Problem.** The product is a daily push, and Telegram gives bots no read receipts. A friend who quietly stops engaging keeps drawing a daily agent run — ~$0.80 billed/day (§2) — for messages no one reads. This pauses those runs automatically after a stretch of silence and gives a one-tap way back. It's cost-of-no-value control, same family as §10, which is why it lives here.

**Trigger — 5 days of silence.**
- "Silence" = no inbound Telegram message from the athlete (text *or* button tap — `messages` table, `direction='in'`). **Strava uploads do not count** (David's call): messages-only keeps the cron query simple, and a false positive on a quiet-but-engaged reader costs nothing more than one tap or message to undo (resume is self-service), so the tighter 5-day window is safe.
- **Activity baseline** = the most recent of *(last inbound message, athlete-creation timestamp)*. A freshly-onboarded athlete who hasn't chatted since onboarding isn't paused on day one — their onboarding messages (and, failing those, their `created_at`) start the clock. This is why no separate new-athlete grace period is needed; 5 days covers it. (Implementation uses `athletes.created_at` as the floor — there is no `onboarded_at` column, and onboarding always produces inbound `messages` rows, so the floor only matters for an athlete who somehow has none.)
- Evaluated inside the **existing daily enqueue cron pass** (SPEC §3.5/§3.7). The cron already skips test athletes (negative `telegram_chat_id`) and non-onboarded athletes; for each remaining athlete it now also computes the activity baseline. **Applies to comped friends too** — `comped` skips *billing*, not the cost-saving pause; the inactive comped/free friends are exactly the ~$16/mo-each subsidy this is meant to stop.

**On pause:**
- Set `paused_at = now()`, `pause_reason = 'auto_inactivity'`. Leave `pause_resumes_at` null — inactivity pause is indefinite; the friend returns by engaging, not on a timer.
- Do **not** enqueue a run for that athlete that day.
- Send **exactly one** static notification with an inline resume button. **This message must not itself be an agent run** — it's a hard-coded template sent straight through the Telegram API, or the feature spends model money to announce it's saving model money. Notify-once falls out of the existing filter for free: once `paused_at` is set, the enqueue predicate (`paused_at is null`) skips the athlete on every later pass, so they're never re-evaluated and never re-notified.

**Notification copy (static template — hand-written, not agent-generated; finalized 2026-06-22, `AUTO_PAUSE_NOTICE` in `pause.ts`):**

> It's been a little while since I heard from you, so I've paused your daily check-ins. Want them back? Tap below, or just send me anything.
>
> `[ Turn daily check-ins back on ]`

Follows the CLAUDE.md copy rules — short, no "Great", no exclamation-stacking, no guilt trip, no AI tells. Number-agnostic on purpose ("a little while", not "10 days") so the window can move without a copy edit.

**Resume — two paths, both clear the pause:**
1. **Button** (`callback_data: resume:auto`) → clear `paused_at` + `pause_reason`, confirm, and (optional but recommended) enqueue today's check-in immediately so coming back feels live rather than "starts tomorrow."
2. **Any inbound message** → an athlete paused with `pause_reason = 'auto_inactivity'` who sends *anything* is auto-resumed (clear the pause), then their message is handled normally. Any engagement means they're back; don't make them hunt for the button.

   **This diverges from §10 on purpose, and `pause_reason` is the switch.** A *manual* (`/pause`, vacation) pause does **not** resume on an inbound — per §10 a friend can ask an ad-hoc question while still on vacation. Only `auto_inactivity` pauses resume on inbound. Same column, opposite inbound behavior, gated on `pause_reason`.

**Cost of the feature itself:** zero model spend — a SQL check inside a cron that already runs, plus a static Telegram send. The savings are the suppressed daily runs.

**Interaction with the $0 gate (§5, once it ships):** skip the inactivity scan for athletes already blocked at $0 — they've already stopped running and received the §8 final message; a second "paused" note would just be noise.

**State / schema (what this section adds):**
- `athletes.paused_at timestamptz null` — shared with §10; **introduced here if this ships first** (null = active).
- `athletes.pause_reason text null` — `'auto_inactivity' | 'manual'`, null when active. New in this section; §10's `/pause` sets `'manual'`.
- `pause_resumes_at` is a §10 concern (timed manual pause) and is **not** needed here. §10 adds it when it lands.
- The enqueue cron's active-athlete predicate gains `paused_at is null` — the same load-bearing filter §10 needs.

**Admin (§11):** surface `pause_reason` so "auto-paused, went quiet" reads differently from "on vacation (`/pause`)" and "out of credit." At <25 friends, David may just text an auto-paused friend directly rather than wait for them to tap back in.

**Standalone build steps:**
1. Migration: add `paused_at`, `pause_reason` to `athletes`.
2. Enqueue cron: add `paused_at is null` to the active predicate; in the same pass, compute each candidate's activity baseline and, if it's older than `INACTIVITY_WINDOW_DAYS` (5), set the pause + send the static template instead of enqueuing. (A `?dryRun=1` / `AUTO_PAUSE_DRY_RUN` guard reports candidates without writing/sending — used to vet the candidate list before arming.)
3. Resume-button callback (`resume:auto`) in the bot's callback dispatcher: clear the pause, confirm, optional immediate check-in.
4. Inbound auto-resume: in the message handler, if the athlete is paused with `pause_reason = 'auto_inactivity'`, clear the pause before normal handling.
5. Static notification template + button.

§10 (manual `/pause`/`/resume`, timed pause, `pause_resumes_at`) then reuses steps 1–2 and the filter, reducing to a thin wrapper over the primitive shipped here.

---

## 11. Comp & admin

- **`comped` flag** per athlete, set from the David-only admin console. True ⇒ all billing logic is skipped.
- Admin console additions: view balance + recent ledger per athlete; **paused state surfaced** so "on vacation" reads differently from "out of credit"; **manual adjust** (`kind=adjust`, signed, with a note) for comps/make-goods; toggle `comped`. Refunds are issued from the **Stripe dashboard** directly (low volume, friends) and mirrored back as a `kind=refund` ledger row by the `charge.refunded` webhook (built 2026-06-23, step 3) — no in-app refund UI in v1. The handler resolves the athlete from the original `kind=topup` ledger row for that `payment_intent` (not from charge metadata), credits `−amount_refunded`, and is idempotent on `(payment_intent, refund)`. **v1 limitation:** because idempotency is keyed per-`(payment_intent, kind)`, only the **first** `charge.refunded` per charge is mirrored — a *second* partial refund on the same charge is deduped and dropped. Acceptable for friends + full refunds from the dashboard; revisit (key on the Stripe refund id) only if partial refunds become real.

---

## 12. Build sequencing

Roughly a week, gated behind the worker + agent loop already running:

1. ✅ **Migration (done 2026-06-22):** `athlete_credits` + `credit_ledger`; the `$5 grant` fires on onboarding completion via the idempotent `grant_signup_credit` RPC. Existing friends backfilled. David comped; friends metered. See §4.
2. ✅ **Draw-down + gate (done 2026-06-22):** `debit_run_credit` RPC (post-run, idempotent on the run via a partial unique index, comped no-op) + the pre-run gate at dequeue, the **whole gate behind `BILLING_GATE_ENABLED` (default off)** — David's call: meter live now, start enforcing when `/buy` exists. Markup centralized in `src/server/billing/pricing.ts` (`billedCents`). Verified against prod (`scripts/verify-drawdown.ts`, self-cleaning throwaway athlete). See §5.
3. **Stripe Checkout + webhook:** API route to create Sessions; `checkout.session.completed` + `charge.refunded` webhook handlers (signature-verified, idempotent on payment_intent). Test mode first.
4. **Telegram commands:** `/balance`, `/buy` with preset buttons, confirmation messages; register in command menu + `/help`.
5. **Warnings:** heads-up + final, burn-rate helper over `athlete_cost_rollup`.
6. **Auto-reload:** card capture via `setup_future_usage`; off-session PaymentIntent at the gate; toggle UI.
7. **Admin:** balance/ledger view, manual adjust, `comped` toggle, paused-state display.
8. **Pause:** `athletes.paused_at` / `pause_resumes_at` columns; `/pause` (incl. timed) + `/resume`; the enqueue-cron skip filter; the auto-resume cron pass.

Ship 1–4 together (the minimum that lets a friend run out and pay). 5–8 follow; pause (8) can land early and independently if a friend takes a trip before the rest is built.

**§10.5 (auto-pause on inactivity) is a build-first candidate that sits outside this sequence.** It ships the pause primitive — `paused_at` + `pause_reason` columns, the enqueue skip filter, and the resume paths — with no dependency on credits, Stripe, or the gate, so it can go in ahead of everything above. Once it's in, step 8 reduces to adding manual `/pause`/`/resume` (+ timed `pause_resumes_at`) on top of the primitive.

---

## 13. Open risks & deferred

- **Stripe Tax / sales tax on digital goods.** Ignored in v1 (5–25 friends, cost-recovery). Revisit if this ever becomes a real product.
- **Mini App webview** for in-window payment — deferred (§3). Plain link first.
- **Telegram Stars** as an alternative rail — rejected on economics, not revisited unless Telegram changes the cut.
- **Measured run cost still exceeds the SPEC §2.1 estimate** (§2): ~$0.53/athlete/day raw (friends only) vs §2.1's $0.08 hybrid / $0.24 Opus-heavy (~2.2–6.6×). Thread (a) — is the worker actually getting prompt-cache hits — is **resolved**: 83% of input tokens are cache reads (measured 2026-06-22); the remaining lever is Sonnet-for-daily routing, not caching. (b) the free/comped friend subsidy is ~$16/friend/mo at this burn, so "free for the first ~20" is a ~$320/mo decision — smaller than the old ~$500 estimate but still not a rounding error. The $5 grant (~6 days) and $25 default (~4.5 weeks) may want revisiting — pending David.
- **Card-on-file SCA / declines** for off-session auto-reload — handled by falling through to the manual gate, but European cards or step-up auth will fail off-session more often. Not a concern for a US friend group; note it.
- **BYO-plan friends** spend tokens in their own Claude/ChatGPT for plan-gen, so our metered cost is daily check-ins + ad-hoc only. The runway math already assumes this.

---

## Sources

- [Telegram — Bot Payments API for Digital Goods (Stars)](https://core.telegram.org/bots/payments-stars)
- [Telegram — Bot Payments API](https://core.telegram.org/bots/payments)
- [Telegram Stars: Pay for Digital Goods](https://telegram.org/blog/telegram-stars)
- [GramBase — Telegram Payments Guide 2026 (methods, fees)](https://grambase.ai/blog/telegram-payments-guide-2026)
- [GramBase — Telegram Stars Guide 2026 (fees, withdrawals)](https://grambase.ai/blog/telegram-stars-guide-2026)
- SPEC §2.1 (cost model), §3.5 (run persistence + `TODO(#12)`), §3.11 (billing stub).
