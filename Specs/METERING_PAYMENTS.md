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

---

## 2. Economics

Balance is denominated in **real dollars the friend paid**. A run that costs us `$cost_usd` of model time debits `cost_usd × 1.5` from the balance. So $25 of credit covers ~$16.70 of actual model cost; the other ~$8.33 is the buffer.

**Planning number (measured 2026-06-05): raw ~$0.85/athlete/day → billed ~$1.28/day.** Observed average from `agent_runs` was $1.22/day; David discounted ~30% as testing noise. This is **3.6–10.7× the SPEC §2.1 estimates** ($0.08 hybrid / $0.24 Opus-heavy) the first draft of this doc used — §2.1's steady-state cost table is stale and the runway numbers below replace the original ones.

| Amount | Runway at $1.28/day billed |
|---|---|
| $5 (free grant) | **~4 days** |
| $10 | ~8 days |
| $25 (default top-up) | **~2.8 weeks** |
| $50 | ~5.6 weeks |

Per athlete per month: **~$26 raw, ~$39 billed.**

Takeaways:
- **This is now a ~$39/mo product, not a top-up-twice-a-year one.** The original "$25 lasts months, friends rarely see a paywall" framing is dead at measured burn. A paying friend tops up roughly monthly — auto-reload goes from nice-to-have to the sane default behavior to *recommend* (still opt-in per the locked decision).
- **The $5 grant buys ~4 days** — a taste, not a trial of a real training week. Flagged for David: either accept it as a deliberate short taste or raise the grant. (Decision pending; $5 stands until he says otherwise.)
- **Free friends now cost real money.** At ~$26/mo raw, every comped/free friend is ~$26/mo out of pocket — ~$520/mo if 20 friends ride free. The cheapest fix is not pricing, it's cost: confirm the measured number reflects prompt caching + Sonnet-for-daily routing as specced (§2.1's hybrid assumption). If runs are uncached or Opus-everywhere, fixing that is worth more than any billing knob in this doc.
- **The buffer now clears infra.** 0.5× on $0.85/day collects ~$13/mo per paying athlete vs ~$1 of Stripe fees per monthly top-up — hosting amortization is comfortably covered (reverses the first draft's caveat).
- **Re-measure after cost optimization and real (non-test) traffic.** Recompute median billed-$/day from `athlete_cost_rollup` excluding test athletes; re-sanity-check the $5 grant and $25 default then.

---

## 3. Why Stripe, not Telegram Stars

Telegram policy: digital goods and services sold *inside* Telegram via the Bot Payments API must be sold in **Telegram Stars** (currency `XTR`). Third-party providers (Stripe, etc.) through that API are reserved for *physical* goods. Coaching credits are a digital service, so an in-window Bot-Payments purchase would be forced onto Stars.

Stars carry Telegram's revenue share **plus** the Apple/Google in-app-purchase cut — creators typically net **50–70%** of face value. On a near-pass-through, cost-recovery product that's a 30–50% tax that would exceed the entire buffer. Stripe is ~2.9% + $0.30 (4.1% on a $25 charge).

**The compliant pattern we use:** the bot sends a normal `https` **Stripe Checkout link**. Payment happens on Stripe's hosted page in the browser — outside Telegram's payment rail — so the digital-goods rule doesn't apply. The friend leaves the Telegram window for ~20 seconds and comes back; the bot confirms via webhook.

**Mini App (deferred, optional):** a Telegram Mini App webview wrapping the same Stripe Checkout would keep it feeling in-app. It's nicer UX but adds an Apple/Telegram policy gray area (in-app webviews selling digital goods). For 5–25 friends the enforcement risk is near zero, but the plain link ships first and carries no policy risk. Revisit the Mini App only if the browser hop proves to be real friction.

---

## 4. Data model

New tables/columns (migration in `supabase/migrations/`):

```
athlete_credits        (athlete_id PK/FK, balance_cents int not null default 0,
                        comped bool not null default false,
                        stripe_customer_id text,            -- set on first Checkout
                        auto_reload_enabled bool default false,
                        auto_reload_threshold_cents int default 300,   -- $3
                        auto_reload_amount_cents int default 2500,     -- $25
                        default_pm_id text,                 -- saved card for off-session
                        low_balance_warned_at timestamptz,  -- dedupe the ~1wk heads-up
                        updated_at timestamptz)

credit_ledger          (id, athlete_id FK, kind[grant|topup|debit|refund|adjust],
                        amount_cents int,                   -- signed: +credit, -debit
                        balance_after_cents int,
                        related_run_id FK nullable,         -- for debits
                        stripe_payment_intent text nullable,-- for topups/refunds
                        note text, created_at)
```

- **`athlete_credits` is the live balance; `credit_ledger` is the append-only audit.** Every mutation writes both in one transaction. Balance is reconstructable from the ledger — the table is a cache for the hot path.
- Cents, not dollars, everywhere. No floats on money.
- `comped = true` short-circuits all billing: no debit, no warning, no gate.
- This reuses David's familiar shape — a never-overwritten log (`credit_ledger`) plus an overwritten latest-state (`athlete_credits`).

The `$5` grant is a single `kind=grant` ledger row written at the moment the athlete row is created (end of onboarding).

---

## 5. Draw-down + the $0 gate

Fills the `// TODO(#12)` hook in `worker/run-agent.ts`.

1. **Decrement (post-run):** after the agent run persists `agent_runs`, in the same transaction debit `round(cost_usd × 1.5 × 100)` cents from `athlete_credits`, write a `kind=debit` ledger row referencing the run. Skip entirely if `comped`.
2. **Gate (pre-run, at dequeue):** when the worker pulls a `daily_checkin` or `adhoc` job, check balance **before** running. If `balance_cents <= 0` and not `comped`, **don't run** — mark the job blocked, and send the friend the final top-up message (§8). The in-flight run that drove them to $0 always completes; the *next* one is what's refused. No debt, no negative balance.
3. **Auto-reload interception:** the gate first checks whether auto-reload is on and the balance is below threshold; if so it attempts the off-session charge (§7) and, on success, proceeds. Only a failed/absent reload blocks.

Edge: a single expensive run can overshoot a tiny positive balance into negative. That's fine — we let the in-flight run finish and land the balance slightly negative; the next top-up reconciles (the ledger carries the true number). We never *start* a run from `<= 0`.

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
4. **Stripe webhook** (`checkout.session.completed`) → verify signature → look up `athlete_id` → credit the **net or gross?** Decision: **credit the gross amount the friend paid** ($25 → $25 of balance). The Stripe fee is absorbed by the buffer, not deducted from their balance — simpler and friendlier. Write `kind=topup` ledger row + bump balance, idempotent on `payment_intent` id.
5. Bot sends a confirmation to Telegram ("$25 added — you're at $X, about N weeks at your pace.").

Use **dynamic Checkout Sessions, not pre-made Payment Links** — we need per-athlete attribution, variable amounts, and conditional card-saving, none of which static links handle cleanly.

Webhook idempotency: dedupe on `payment_intent`; a replayed event must not double-credit.

---

## 7. Auto-reload (opt-in)

- **Off by default.** Offered as a checkbox/secondary button during a `/buy` flow and toggleable later from the help menu. Never silently enabled.
- **Enabling** requires a saved card. We capture it by setting `setup_future_usage = 'off_session'` on the *next* Checkout the friend completes, then store the resulting `payment_method` id as `default_pm_id` (and the `customer` id). No card on file ⇒ auto-reload can't be turned on; the bot says so and points to `/buy`.
- **Trigger:** at the pre-run gate, if `auto_reload_enabled` and `balance_cents < auto_reload_threshold_cents` ($3), create an **off-session PaymentIntent** for `auto_reload_amount_cents` ($25) against `default_pm_id`. On success → credit + `kind=topup` ledger row + proceed with the run + a quiet "auto-reloaded $25" note. On failure (card declined, SCA required) → fall through to the $0 gate behavior and tell the friend their auto-reload failed with a `/buy` link.
- **$3, not "1 week of runway":** David's call. Simpler and predictable. Note that at measured burn (~$1.28/day billed, §2) $3 is only ~2.3 days of runway — the trigger fires with one or two runs to spare rather than a comfortable margin. Acceptable (worst case defers one run to a manual top-up), but if average cost rises further, bump the threshold before friends start hitting the gate with auto-reload on.

---

## 8. Warnings & burn-rate

**Burn rate** = trailing-14-day billed cost ÷ 14, read from `athlete_cost_rollup` (×1.5 to convert raw→billed). New athletes with <3 days of history use a default of $1.28/day (the measured fleet average, §2 — keep this constant in one place and update it when the average moves). **Runway days** = `balance / billed_per_day`.

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

## 11. Comp & admin

- **`comped` flag** per athlete, set from the David-only admin console. True ⇒ all billing logic is skipped.
- Admin console additions: view balance + recent ledger per athlete; **paused state surfaced** so "on vacation" reads differently from "out of credit"; **manual adjust** (`kind=adjust`, signed, with a note) for comps/make-goods; toggle `comped`. Refunds are issued from the **Stripe dashboard** directly (low volume, friends) and mirrored back as a `kind=refund` ledger row by the existing `charge.refunded` webhook — no in-app refund UI in v1.

---

## 12. Build sequencing

Roughly a week, gated behind the worker + agent loop already running:

1. **Migration:** `athlete_credits` + `credit_ledger`; write the `$5 grant` on athlete creation. Backfill existing friends with a grant row.
2. **Draw-down + gate:** implement `// TODO(#12)` decrement; add the pre-run balance gate at dequeue. Unit-test the overshoot-into-negative and comped paths.
3. **Stripe Checkout + webhook:** API route to create Sessions; `checkout.session.completed` + `charge.refunded` webhook handlers (signature-verified, idempotent on payment_intent). Test mode first.
4. **Telegram commands:** `/balance`, `/buy` with preset buttons, confirmation messages; register in command menu + `/help`.
5. **Warnings:** heads-up + final, burn-rate helper over `athlete_cost_rollup`.
6. **Auto-reload:** card capture via `setup_future_usage`; off-session PaymentIntent at the gate; toggle UI.
7. **Admin:** balance/ledger view, manual adjust, `comped` toggle, paused-state display.
8. **Pause:** `athletes.paused_at` / `pause_resumes_at` columns; `/pause` (incl. timed) + `/resume`; the enqueue-cron skip filter; the auto-resume cron pass.

Ship 1–4 together (the minimum that lets a friend run out and pay). 5–8 follow; pause (8) can land early and independently if a friend takes a trip before the rest is built.

---

## 13. Open risks & deferred

- **Stripe Tax / sales tax on digital goods.** Ignored in v1 (5–25 friends, cost-recovery). Revisit if this ever becomes a real product.
- **Mini App webview** for in-window payment — deferred (§3). Plain link first.
- **Telegram Stars** as an alternative rail — rejected on economics, not revisited unless Telegram changes the cut.
- **Measured run cost is 3.6–10.7× the SPEC §2.1 estimate** (§2). Two open threads: (a) verify the worker is actually getting prompt-cache hits and using Sonnet for routine daily runs — if not, cost optimization beats every billing knob here; (b) the free/comped friend subsidy is ~$26/friend/mo at this burn, so "free for the first ~20" is a ~$500/mo decision, not a rounding error. The $5 grant (~4 days) and $25 default (~3 weeks) may want revisiting once (a) is resolved — pending David.
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
