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
| Buffer transparency | **Disclosed.** Help text frames credits as cost-recovery only: the majority goes to AI token costs, a small slice to Stripe fees + hosting, and the cost should fall as Daybreak gets more token-efficient. Exact copy: `CREDITS_DISCLOSURE` in `src/server/telegram/commands.ts` (reframed 2026-06-23 from the original buffer/not-profit wording). |
| Payment rail | **Stripe Checkout via a link the bot sends.** Not Telegram Stars. (§3) |
| Top-up amounts | **Presets $10 / $25 / $50, default $25.** |
| Auto-reload | **Opt-in, off by default.** When on: balance **< $3 → charge $25** off-session. **(Build deferred 2026-06-24, David's call — §7. Friends top up manually via `/buy`.)** |
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

> **DEFERRED — 2026-06-24 (David's call).** Not in the v1 build. Friends top up manually via `/buy` (§6, shipped). The `auto_reload_enabled` / `auto_reload_threshold_cents` / `auto_reload_amount_cents` / `default_pm_id` columns exist in `athlete_credits` (migration §4) but stay unused, and the §5 gate's "auto-reload interception" step stays deferred with it. Revisit only if manual top-ups prove to be real friction. The design below stands for whenever it's picked up.

- **Off by default.** Offered as a checkbox/secondary button during a `/buy` flow and toggleable later from the help menu. Never silently enabled.
- **Enabling** requires a saved card. We capture it by setting `setup_future_usage = 'off_session'` on the *next* Checkout the friend completes, then store the resulting `payment_method` id as `default_pm_id` (and the `customer` id). No card on file ⇒ auto-reload can't be turned on; the bot says so and points to `/buy`.
- **Trigger:** at the pre-run gate, if `auto_reload_enabled` and `balance_cents < auto_reload_threshold_cents` ($3), create an **off-session PaymentIntent** for `auto_reload_amount_cents` ($25) against `default_pm_id`. On success → credit + `kind=topup` ledger row + proceed with the run + a quiet "auto-reloaded $25" note. On failure (card declined, SCA required) → fall through to the $0 gate behavior and tell the friend their auto-reload failed with a `/buy` link.
- **$3, not "1 week of runway":** David's call. Simpler and predictable. Note that at measured burn (~$0.80/day billed, §2) $3 is only ~3.8 days of runway — the trigger fires with a few runs to spare rather than a comfortable margin. Acceptable (worst case defers one run to a manual top-up), but if average cost rises further, bump the threshold before friends start hitting the gate with auto-reload on.

---

## 8. Warnings & burn-rate

**Burn rate** = recent billed cost per day, read from `athlete_cost_rollup` (×1.5 to convert raw→billed). New athletes with <3 days of history use a default of $0.80/day (the measured friends-only average, §2 — keep this constant in one place and update it when the average moves). **Runway days** = `balance / billed_per_day`.

> **Built 2026-06-23 (step 4) — `src/server/billing/burn-rate.ts`.** The helper uses the rollup's **7d window** (`cost_usd_7d / 7`), not the 14-day window this section originally specified: `athlete_cost_rollup` only exposes 7d/28d, and adding a 14d column is a migration the step didn't warrant. The 7d window is more recent-weighted, which is fine for a runway estimate. The `$0.80/day` default lives as `DEFAULT_BILLED_PER_DAY_CENTS = 80` in that file (the one place, per §2). `runwayLabel()` renders "about N days / about a week / about N weeks." If a 14d basis is ever wanted, add `cost_usd_14d`/`runs_14d` to the rollup view and switch the helper.

- **Heads-up (~2 days left):** when projected runway drops to ~2 days while the balance is still positive, send one message, then set `low_balance_warned_at` to dedupe; a top-up clears it so the next cycle warns again. Plain text (no buttons), nudging toward `/buy`.
- **Final (at $0):** sent by the gate when a run is blocked. Includes the `$10 · $25 · $50` preset buttons.
- Comped friends get neither.
- Both messages must read like a person wrote them — short, no "Great news!", no exclamation-stacking. See CLAUDE.md copy rules.

> **Built 2026-06-24 (step 5) — `worker/billing.ts::maybeWarnLowBalance`, `worker/send.ts::sendTopupButtons`, `src/server/billing/credits.ts` helpers.** Four deliberate deviations from the bullets above, all signed off this session:
> - **Threshold is ~2 days, not ~7** (`HEADS_UP_RUNWAY_DAYS = 2`). The $5 signup grant is only ~6 days of runway at the §2 burn, so a 7-day trigger would fire on day one for every new athlete the moment the gate flag flips on. 2 days (~$1.60 at default burn) clears the grant and a fresh top-up while still leaving ~2 daily check-ins of lead time before the $0 gate. Days-based (not dollar-based), so a heavier-burn athlete is warned at a correspondingly higher balance.
> - **First-time explainer vs recurring short version.** The heads-up is an athlete's first contact with the credits idea (onboarding never mentions it, and the system is dark until the gate flips), so the first one introduces credits before stating the balance; every one after is the short nudge ("Quick heads-up: about $X of credit left, {runway} at your pace. Top up anytime with /buy."). Selection is by **top-up history** (`hasToppedUp` — a `kind='topup'` ledger row), no migration. This is an airtight once-ever guard: `low_balance_warned_at` is cleared *only* by a top-up, which is exactly what flips the selector to the short version, so the explainer fires at most once. `hasToppedUp` only picks the text; the warned-at column owns the dedupe.
> - **Buttons only on the final, not the heads-up.** The heads-up is plain text via `sendReply` (the `/buy` mention is the affordance); the `$10/$25/$50` presets are reserved for the $0 final notice, where removing friction matters. The shared `sendTopupButtons(athleteId, text)` helper builds the keyboard (callback_data `buy:<cents>`, handled cross-process by the inbound bot's dispatcher) and is used only by the final notice.
> - **Heads-up fires post-debit in the worker** (`run-agent.ts`, after the draw-down lands and the coach's reply is sent, so the nudge follows the coaching), gated behind the same `BILLING_GATE_ENABLED` flag as the rest of the gate — dark in the free era. Best-effort send-then-mark: a rare failed send still dedupes (the $0 gate, which re-sends on every blocked run, is the real backstop). Runway uses the rollup's **7d** window per the step-4 note above, not 14d.

---

## 9. Telegram surface

Commands, all registered in the bot command menu (alongside `/edit_profile`, `/calendar`) and described in `/help`:

- **`/balance`** → "$18.40 left — about 5 weeks at your pace." Dollars + estimated time remaining (burn-rate calc from §8). If comped: "You're on the house — no credit needed." If paused: prepend the paused state (§10). If auto-reload on: append "Auto-reload: on (+$25 at $3)."
- **`/buy`** → the preset-button flow (§6). Also the entry point to toggle auto-reload.
- **`/pause`** / **`/resume`** → suspend and restore proactive daily check-ins (§10).

Help-menu block (`/help`) states plainly that credits are cost-recovery only — the majority of a friend's credit goes to AI token costs, a small slice to Stripe fees + hosting, and the cost should come down over time as Daybreak gets more token-efficient. Two or three sentences, David's voice. Built copy lives in `CREDITS_DISCLOSURE` (`src/server/telegram/commands.ts`, shipped 2026-06-23 — reframed from the original buffer/not-profit wording, which over-emphasized the markup); edit it there, not here.

Payment itself happens on Stripe's hosted page via the link — the only step that leaves Telegram. Everything else (checking balance, choosing an amount, getting confirmation, managing auto-reload) stays in the chat.

---

## 10. Pause / vacation mode (`/pause`, `/resume`)

**Shipped 2026-06-24 (step 8) — `/pause` + `/resume` only.** The timed form (`/pause 7`, `/pause until <date>`), the `pause_resumes_at` column, and the auto-resume cron pass were **cut** (David's call): a manual pause is indefinite until `/resume`. There is no migration — `/pause`/`/resume` are a thin layer over the pause primitive already shipped by §10.5 (`paused_at` + `pause_reason`, the enqueue skip filter, the inbound-resume gate on `pause_reason`).

Lets a friend stop proactive daily check-ins while away — vacation, travel, an injury layoff — so they don't burn credit on messages they won't read. This is cost-of-no-value control: the reason it lives in this doc.

- **`/pause`** — suspends the proactive daily check-in indefinitely (`pause_reason = 'manual'`). Bot confirms "off until you run /resume." Already-paused replies idempotently.
- **`/resume`** — clears the pause **and kicks off a fresh check-in immediately**, so coming back feels live rather than "starts tomorrow." The run is keyed **per-`/resume`** (`daily-resume-{athlete_id}-{message_id}`), *not* the cron's `daily-{athlete_id}-{date}` key: that per-day key already exists on any day the morning check-in ran, so reusing it (enqueue is an ignore-duplicates upsert) would silently dedup and nothing would arrive — the bug found in the first build. The pause→active transition gates it (a repeat `/resume` returns not-paused without enqueuing), so it's **one agent run per resume** — accepted. Bot confirms. Not-paused replies idempotently.
- **While paused:**
  - The daily enqueue (SPEC §3.5/§3.7 — the Vercel cron that inserts `daily-{athlete_id}-{date}` jobs) **skips paused athletes**, so daily spend goes to zero. This filter is the load-bearing change; the command is a thin wrapper over it.
  - **All proactive pushes stop, not just the daily.** The post-activity trigger (SPEC §3.5.1 — the Strava-webhook `post_activity` run, `src/server/strava/activity-trigger.ts`) also skips paused athletes: it's proactive spend in the same family, and a Strava upload is **not** engagement (§10.5), so logging a run while paused neither resumes the athlete nor earns a message. (Shipped 2026-06-24 — the trigger originally checked only onboarded/non-test + the cooldown, so a quiet-but-still-running friend kept getting pinged.)
  - Low-balance warnings and the auto-reload check are suspended too — nothing is burning, so there's nothing to warn about or reload for.
  - **Ad-hoc messages still work.** If the friend messages the bot it answers and debits normally (user-initiated = getting value). It does *not* silently flip daily back on (inbound-resume is gated on `pause_reason`, so a `manual` pause survives an inbound — only an `auto_inactivity` pause resumes on a message, §10.5); instead the bot sends a light "Your account is paused. I'll still get back to you on this, but note that you will not receive any proactive messages until you run /resume." Because the worker sends the real coaching reply asynchronously, this notice is a **separate inline message** from the webhook that lands with the 👀, *ahead* of the coach reply — so the copy says a reply is still coming (it can't literally be appended to the worker's reply without touching the worker). Fires on each ad-hoc message while manually paused. Keeps state predictable.
- **State lives on `athletes`, not `athlete_credits`** — it's coaching-loop state, not billing state. `paused_at timestamptz null` (null = active) and `pause_reason text null` (`'manual'` here; `'auto_inactivity'`/`'dormant'` elsewhere). Both columns already exist from §10.5 — no migration. The enqueue cron's active-athlete predicate already carries `paused_at != null` skip. (`pause_resumes_at` was cut — there is no timed pause.)
- **Plan continuity:** pausing suppresses messages only; it does not edit the plan. On resume the bot picks up at the current calendar date, which may be mid-plan — the resume confirm ("Back on. I'll pull your latest…") plus the immediately-enqueued check-in orient the friend rather than pretending no time passed.

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
3. ✅ **Stripe Checkout + webhook (done 2026-06-23):** API route to create Sessions; `checkout.session.completed` + `charge.refunded` webhook handlers (signature-verified, idempotent on `(payment_intent, kind)` — per-kind, not the PI alone, so a topup and its later refund coexist; see §6). Test mode first.
4. ✅ **Telegram commands (done 2026-06-23):** `/balance`, `/buy` with preset buttons, confirmation messages; registered in the command menu + `/help`.
5. ✅ **Warnings (done 2026-06-24):** heads-up + final, burn-rate helper over `athlete_cost_rollup`. Heads-up at ~2-day runway (plain text, first-time credits explainer vs recurring short version by top-up history); final at $0 carries the preset buttons. See §8's step-5 note for the deviations from the original spec.
6. **Auto-reload — DEFERRED (2026-06-24, David's call; §7):** card capture via `setup_future_usage`; off-session PaymentIntent at the gate; toggle UI. Not in v1 — friends top up manually via `/buy`. Revisit only if manual top-ups become real friction.
7. ✅ **Admin (done 2026-06-24):** password-gated `/admin` on the deployed Daybreak domain (David's design constraint — not a local tool). Roster (balance, comped, paused-state-distinct-from-out-of-credit, runway, sorted by balance asc) + per-athlete detail (recent `credit_ledger` audit rows) + the two §11 mutations: **manual signed adjust** (required note) via the new `adjust_credit` RPC (migration `20260624000000_metering_adjust.sql` — `kind='adjust'`, atomic ledger row + balance bump, **not idempotent**, ignores `comped`) and **`comped` toggle**. Auth = single shared `ADMIN_PASSWORD` (timing-safe) → signed httpOnly+Secure cookie (7-day, logout), reusing the `state-sign.ts` HMAC over `STATE_SIGNING_KEY`; the gate is a route-group Server Component layout (Node `crypto`), not middleware (Edge lacks `createHmac`). No in-app refund UI (dashboard + `charge.refunded` mirror, per above); no auto-reload UI (step 6). Plain Tailwind, no component library (anti-goal §5). Verified against prod (`scripts/verify-adjust.ts`, 16/16, self-cleaning). **Web-only — commit → push, no `fly deploy`.** **Follow-up (same day):** roster gains an **inactivity-countdown column** (days until §10.5 auto-pause — a pure `daysUntilAutoPause` in `pause.ts` that mirrors `isInactive`'s baseline so the display can't drift from the cron's decision; `—` for test/not-onboarded/already-paused) and a per-athlete **manual-pause control** that fires the *same* auto-pause as the cron via a shared `autoPauseAthlete` (`pause_reason='auto_inactivity'` + the static notice with the resume button — chosen over a `'manual'` vacation pause so an inbound resumes them and the notice's "send me anything" copy stays truthful). The cron itself is left untouched (its test mocks the notice send in isolation); the shared piece is `sendAutoPauseNotice`.
8. ✅ **Pause (done 2026-06-24):** manual `/pause` + `/resume` only — a thin layer over the §10.5 pause primitive (no migration; `paused_at` + `pause_reason` already exist). `/pause` sets `pause_reason='manual'` (indefinite); `/resume` clears it and kicks off a fresh check-in immediately (keyed per-`/resume`, *not* the cron's per-day key — reusing that dedups against the morning run and nothing arrives; one run per resume via the pause→active transition gate). Ad-hoc message while manually paused → answered + debited + a light "still paused — /resume" inline notice, no daily flip-on (gated on `pause_reason`). Menu entries + `commands:register`. **Timed pause (`/pause 7`/`until`), `pause_resumes_at`, and the auto-resume cron pass were cut** (David's call). Web-only — commit → push, no `fly deploy`. See §10.
9. **Model tiers (`/model`):** `athletes.model_tier` column; per-source model resolve in the worker (proactive = daily + post-activity → cheaper, interactive = replies → smart); `/model` tier buttons; menu/`/help`. The Haiku-proactive **default** is gated on the §14 A/B; the tier mechanism + Saver ship regardless. Independent of the gate and warnings — can land any time. See §14.

Ship 1–4 together (the minimum that lets a friend run out and pay). 5–9 follow; pause (8) and model selection (9) can each land early and independently.

**§10.5 (auto-pause on inactivity) is a build-first candidate that sits outside this sequence.** It ships the pause primitive — `paused_at` + `pause_reason` columns, the enqueue skip filter, and the resume paths — with no dependency on credits, Stripe, or the gate, so it can go in ahead of everything above. Once it's in, step 8 reduces to adding manual `/pause`/`/resume` on top of the primitive (done 2026-06-24 — timed pause cut, so no `pause_resumes_at`).

---

## 13. Open risks & deferred

- **Stripe Tax / sales tax on digital goods.** Ignored in v1 (5–25 friends, cost-recovery). Revisit if this ever becomes a real product.
- **Mini App webview** for in-window payment — deferred (§3). Plain link first.
- **Telegram Stars** as an alternative rail — rejected on economics, not revisited unless Telegram changes the cut.
- **Measured run cost still exceeds the SPEC §2.1 estimate** (§2): ~$0.53/athlete/day raw (friends only) vs §2.1's $0.08 hybrid / $0.24 Opus-heavy (~2.2–6.6×). Thread (a) — is the worker actually getting prompt-cache hits — is **resolved**: 83% of input tokens are cache reads (measured 2026-06-22); the remaining lever is model routing, not caching — now surfaced to friends as the `/model` command (§14). (b) the free/comped friend subsidy is ~$16/friend/mo at this burn, so "free for the first ~20" is a ~$320/mo decision — smaller than the old ~$500 estimate but still not a rounding error. The $5 grant (~6 days) and $25 default (~4.5 weeks) may want revisiting — pending David.
- **Card-on-file SCA / declines** for off-session auto-reload — handled by falling through to the manual gate, but European cards or step-up auth will fail off-session more often. Not a concern for a US friend group; note it.
- **BYO-plan friends** spend tokens in their own Claude/ChatGPT for plan-gen, so our metered cost is daily check-ins + ad-hoc only. The runway math already assumes this.

---

## 14. Model selection (`/model`)

**Status: proposed 2026-06-24 — pending David's review.** A `/model` command that lets a friend pick a coaching **tier** (Saver / Standard / Premium), trading cost for quality. Each tier is a *(proactive model, interactive model)* pair, not a single model — because the two kinds of run have opposite cost/value profiles, and the highest-leverage move is to put the cheap model on the high-volume automated runs while keeping the good model where a friend is actually in a conversation. The smart split is also the **default**, so the whole friend group gets the cut without anyone choosing. Model choice is the biggest remaining burn-rate lever (§2/§13).

### Why it fits the metering model with no billing change

The draw-down meters **actual** model cost: each run records `agent_runs.cost_usd` from the SDK's real token usage, and `billedCents` applies the flat 1.5× markup on top (§2, §5). So the model a run used is already baked into the number — a Haiku run debits less (and the §8 runway stretches) automatically; an Opus run debits more. **No markup change, no per-model pricing table in our code** — the ledger captures the truth per run. The markup is model-agnostic on purpose.

### Where the spend actually goes (measured 2026-06-24, friends only, trailing 30 days)

| Bucket | Run source | Share of spend |
|---|---|---|
| **Proactive** — morning daily | `daily_checkin` | 38% |
| **Proactive** — post-activity update | `post_activity` | ~19% |
| **Interactive** — replies, `/fresh_update`, `/adjust_plan` | `tg_message` | ~41% |
| (fixed) onboarding + race lookup | — | ~1% |

The two **proactive** runs (daily + post-activity ≈ **57%**) are automated pushes — formulaic, data-driven, and either unread-risk (daily) or short-and-reactive (post-activity). They're the Haiku target. The **interactive** ~41% is where coaching judgment lives and where a friend is paying attention; it stays on the smart model. (List prices per MTok, measured via the Claude API skill: Haiku 4.5 `claude-haiku-4-5` $1/$5 ≈ ⅓ of Sonnet; Sonnet 4.6 `claude-sonnet-4-6` $3/$15 = today's default; Opus 4.8 `claude-opus-4-8` $5/$25 ≈ 1.67×.)

### Tiers (the user-facing surface)

| Tier | Proactive (daily + post-activity) | Interactive (replies) | Est. billed/day | $25 runway | vs today |
|---|---|---|---|---|---|
| **Saver** | Haiku | Haiku | ~$0.26 | ~13 weeks | ~−67% |
| **Standard (default)** | Sonnet† | Sonnet | ~$0.78 | ~4.5 weeks | ~0% |
| **Premium** | Sonnet | Opus | ~$1.02 | ~3.5 weeks | ~+27% |

Estimates scale the measured §2 Sonnet-both baseline ($0.80 billed/day) by each bucket's model ratio and the 38/19/41 split above — planning numbers only; the ledger records the truth. **† The A/B below was run 2026-06-24 and Haiku did not clear it — Standard ships as Sonnet-both (today's behavior), and Haiku-proactive lives only in Saver (opt-in, the friend chose it). See the result under "The A/B that gates the default."** If a later re-test clears it, flipping Standard's proactive to Haiku is a one-line tier-map change.

### Decisions (proposed — confirm before building)

| Dimension | Proposed |
|---|---|
| Surface | Tiers, not raw models — `/model` shows **Saver / Standard / Premium** (current marked), each a (proactive, interactive) pair. Hides the model matrix behind a cost↔quality dial a friend can reason about. |
| Default | **Standard = Sonnet-both** — the A/B (2026-06-24) did not clear Haiku-proactive, so the smart split is not the default. A friend can switch tiers but doesn't have to; Haiku-proactive is Saver-only. |
| Proactive vs interactive | Keyed on the run **`source`** (`daily_checkin` + `post_activity` = proactive; `tg_message` = interactive), which the worker already passes to `runAgent` — **not** `agent_runs.kind`, which collapses post-activity into `adhoc`. |
| Scope | The coaching `query()` in `worker/run-agent.ts` only. **Not** onboarding (fixed Sonnet engine) and **not** plan-repair (`worker/plan-repair.ts` — stays Sonnet so a Haiku daily's plan edit still gets a smart repair pass). |
| Storage | `athletes.model_tier text null` (null = Standard). Coaching-loop state, like `paused_at` — on `athletes`, not `athlete_credits`. Storing the tier (not raw model ids) means redefining a tier is a code change, not a data migration. |
| Cost framing | The `/model` copy names the trade-off plainly (Saver stretches credit / Premium sharpens replies). The metered draw-down already reflects it — nothing else to disclose. |

### Implementation

- **Migration:** `athletes.model_tier text null` with a CHECK on `('saver','standard','premium')` (null = `standard`).
- **Shared tier map:** one module — model-id constants, `PROACTIVE_SOURCES = {'daily_checkin','post_activity'}`, and `TIERS = { saver:{proactive:HAIKU,interactive:HAIKU}, standard:{proactive:SONNET†,interactive:SONNET}, premium:{proactive:SONNET,interactive:OPUS} }` — imported by both the worker (resolve) and the bot (`/model` buttons), the single-source-of-truth shape of `pricing.ts`/`commands.ts`. (`standard.proactive` = SONNET — the A/B (2026-06-24) did not clear Haiku-proactive; see the result below. A passing re-test flips it to HAIKU.)
- **Worker resolve:** `resolveCoachModel(athlete, source)` → `tier = athlete.model_tier ?? 'standard'`; `bucket = PROACTIVE_SOURCES.has(source) ? 'proactive' : 'interactive'`; `return TIERS[tier][bucket]`. Pass into `query({ options: { model } })` and `persistRun` (already records `model`). The `source` is already an argument to `runAgent`.
- **Bot:** `/model` command + `model:<tier>` callback in `src/server/telegram/bot.ts`, mirroring `/buy` (onboarded-guard, three tier buttons with the current pick marked, tap writes `model_tier` + collapses the keyboard + confirms). Register `/model` in `commands.ts` (menu + `/help`).
- **Deploy:** worker change → `fly deploy`; bot/menu change → web push. Both surfaces.

### The A/B that gates the default

The tier mechanism and the **Saver** tier ship regardless. The A/B decides one thing: whether **Standard's proactive slot is Haiku** (a ~39% cut for everyone on the default) or stays **Sonnet** (today's behavior, Haiku-proactive available only via opt-in Saver). The question is *is Haiku good enough for the proactive runs* — decisive for the morning daily (the flagship, most-read message) and lower-stakes for post-activity.

- **Method — controlled side-by-side dry-run.** Hydrate a real athlete's folder once, run the proactive agent against that exact snapshot twice (Haiku and Sonnet) with **send and file-sync disabled**, capture both outputs + cost/tokens/turns. Same inputs, only the model differs.
- **Harness.** `scripts/ab-daily-model.ts` reusing the worker's `hydrate()` + the proactive prompt + `buildAgentOptions()` (extract it from `run-agent.ts` — the `Specs/EVAL_HARNESS.md` prerequisite, so not throwaway), model overridable, side effects off. Run both `daily_checkin` and `post_activity` sources.
- **Sample.** ~6–10 snapshots spanning varied recent Strava — normal day, hard workout, missed run, long run, rest day, an athlete mid-plan-change — across the real friends (read-only; nothing sends).
- **Judge.** (1) **Factual accuracy** — did Haiku read the Strava/plan correctly, no invented data? Objective and checkable against the folder; a miss is an auto-fail, since a proactive run's whole job is to be grounded. (2) **Voice/quality** — a blind Opus judge scores each pair (model identity hidden) and David reads a handful (his voice bar is the real gate).
- **Decision rule.** Haiku becomes Standard's proactive model only if it holds factual accuracy across the sample **and** David accepts the voice — weighting the daily heaviest. Otherwise Standard stays Sonnet-both and Haiku-proactive lives in Saver.
- **Cost.** ~2× a handful of runs, well under $1. Effectively Phase 0 of `Specs/EVAL_HARNESS.md`.

#### Result — run 2026-06-24 (Haiku did not clear; Standard stays Sonnet-both)

Ran Haiku 4.5 vs Sonnet 4.6 as a read-only dry-run across four athletes (David, Brenden, Ian, Chase), `daily_checkin` + `post_activity`, both models against byte-identical hydrated folders per pair. Built broader than the §14 sketch (`scripts/ab-daily-model.ts`): `scripts/ab-model-eval.ts` + `worker/dry-run-agent.ts` + the `buildAgentOptions()` extraction (`worker/agent-options.ts`) — the `Specs/EVAL_HARNESS.md` prerequisite, now done and reusable. Reports: `ab-model-eval-2026-06-24T19-18.md` (the 4-athlete proactive gate) and `ab-model-eval-2026-06-24T18-47.md` (David smoke, one interactive case). 16 proactive runs, $3.17; read-only verified (no `agent_runs` rows, no balance moves, no Telegram sends).

- **Daily — ruled out.** Haiku had a grounding miss on the flagship message (reported a tempo as "12.45 vs 6 planned" — the run's *kilometers* against a 6-*mile* target; it read the same run correctly in its post-activity run, so it's intermittent, not systematic). It also read weaker on tone, detail, and next-step guidance: Sonnet's daily zoomed to the week and gave explicit go/no-go criteria for the peak long run where Haiku stayed list-heavy. Per the decision rule, a factual miss on the flagship is disqualifying.
- **Post-activity — viable but not worth it.** Haiku was clean and cheap on the three routine activities but sprawled on the one consequential case (a post-long-run injury escalation: 13 turns / 7.2k output tokens vs Sonnet's 7 turns), trying to manage the whole situation inline rather than acknowledge-and-defer. With the daily staying Sonnet, post-activity is the only Standard-tier cut left on the table — and at ~19% of spend (~$2–3/athlete/month) the bucket is too small to justify either the quality drop or any routing machinery (a model-classifier router pays a Sonnet tax on the hard cases anyway and adds latency). **David's call (2026-06-24): keep post-activity on Sonnet for now.**
- **Cost ratios, for the record.** Daily Haiku 0.21× Sonnet, post-activity 0.34×. The −39% Standard estimate above assumed *both* proactive runs went Haiku; with the daily on Sonnet, the realized Standard cut would have been only the post-activity bucket. So Sonnet-both stands, and **Saver (Haiku, opt-in) is the cost tier**.
- **Revisit triggers.** A bounded "acknowledge-and-defer" post-activity prompt (keep Haiku in its lane, push replanning to the Sonnet daily) and/or the `<message>`-contract + `sanitizeCoachReply` preamble fix shipped session 68 (the reports predate that fix — the preamble leaks they show are already addressed). Re-run the harness after either before reconsidering.

### Open risks / notes

- **Post-activity is the safest Haiku candidate; the daily carries the quality risk.** Post-activity is short, reactive, and lower-stakes; the morning daily is the flagship message everyone reads — so the A/B weights the daily heaviest, and a clean option if Haiku splits the difference is Haiku-only-on-post-activity for Standard's proactive slot.
- **Replies stay smart in every tier but Saver.** The interactive ~41% bucket — where coaching judgment and engagement live — is Sonnet (Standard) or Opus (Premium) and only drops to Haiku if a friend explicitly picks Saver. So the default cut never touches conversational quality.
- **Haiku context + effort.** Haiku 4.5 is 200K context (vs 1M) and doesn't support `effort`. The folder + 14-day Strava + memory fits 200K comfortably and the worker sets no `effort` today — neither bites now; re-check if agent options change.
- **No guardrail on Opus (Premium).** ~1.7× faster burn; for a friends-only group we disclose it in the copy rather than gate it.
- **Interaction with the gate (§5).** None special — a pricier tier draws the balance down faster and the `$0` gate (once on) catches it the same way. `/balance` runway and the §8 warnings read from `cost_usd`, so they track the chosen tier for free.

---

## Sources

- [Telegram — Bot Payments API for Digital Goods (Stars)](https://core.telegram.org/bots/payments-stars)
- [Telegram — Bot Payments API](https://core.telegram.org/bots/payments)
- [Telegram Stars: Pay for Digital Goods](https://telegram.org/blog/telegram-stars)
- [GramBase — Telegram Payments Guide 2026 (methods, fees)](https://grambase.ai/blog/telegram-payments-guide-2026)
- [GramBase — Telegram Stars Guide 2026 (fees, withdrawals)](https://grambase.ai/blog/telegram-stars-guide-2026)
- SPEC §2.1 (cost model), §3.5 (run persistence + `TODO(#12)`), §3.11 (billing stub).
