# Testing the buy / balance flow with the test athlete

Quick loop for exercising `/buy`, `/balance`, `/help`, and the Stripe topup
confirmation in the test group — **without** re-running onboarding. Builds on the
same harness as `testing-onboarding.md` (staging bot, test group, prod DB). Stays
in Stripe **test mode** throughout.

## Why this works end-to-end

- `/buy`, `/balance`, `/help`, and the button taps are handled by your local
  `bot:dev` process, which runs the **staging** bot (the token in `.env.local`).
  The staging bot is in the group, so its replies arrive there.
- The **topup confirmation** is the one piece sent from **prod Vercel** (the Stripe
  webhook), where `getBot()` is the *real* bot. It routes to the staging bot via
  `botApiForChat` because `STAGING_BOT_TOKEN` is set in Vercel prod (one-time, from
  the onboarding setup). So the confirmation lands in the group too.

## Prereqs (all one-time, already done)

- Staging bot + test group set up (see `testing-onboarding.md` §1–4).
- `STAGING_BOT_TOKEN` set in Vercel prod (`testing-onboarding.md` §4b) — confirmed set.
- `STRIPE_SECRET_KEY` in `.env.local` (test mode) — confirmed set.
- `.env.local` points at the **staging** bot in polling mode:
  ```
  TELEGRAM_BOT_TOKEN=<staging bot token>
  TELEGRAM_BOT_USERNAME=<staging bot username, no @>
  TELEGRAM_BOT_MODE=polling
  ```

## Setup (skip onboarding)

The `/buy` and `/balance` guards only require the athlete to be **onboarded**. If
your test athlete was last `test:reset`, mark it onboarded directly instead of
walking the flow. Run this in the Supabase SQL editor (prod project). The
`telegram_chat_id like '-%'` clause is a safety guard — it can only ever touch the
negative (group) row, never your real athlete.

```sql
-- Mark the test athlete onboarded (v3 'complete'), skipping the onboarding walk.
update athletes a
set onboarding_state = '{"flow":"v3","phase":"complete"}'::jsonb
from users u
where a.user_id = u.id
  and u.email = 'davidjtemple@gmail.com'
  and a.telegram_chat_id like '-%';
```

Grab the athlete id while you're here (for `verify-stripe.ts` below):

```sql
select a.id
from athletes a
join users u on a.user_id = u.id
where u.email = 'davidjtemple@gmail.com'
  and a.telegram_chat_id like '-%';
```

## Run the test

```bash
# Start the staging bot (polls prod for the group's messages). Leave it running.
npm run bot:dev
```

In the **test group**:

1. **`/buy`** → three buttons appear: `$10 · $25 · $50`.
2. Tap one (use **$10** to keep it cheap) → a Stripe checkout link arrives.
3. Open the link, pay with test card **4242 4242 4242 4242** — any future expiry,
   any CVC, any ZIP.
4. Within a few seconds the confirmation lands in the group:
   `"$10 added — you're at $X, about N weeks at your pace."` (This is the prod
   Vercel webhook firing back through the staging bot.)
5. **`/balance`** → `"$X left — about N weeks at your pace."`
   - The test athlete is **comped** by default, so this shows
     `"You're on the house — no credit needed."` instead. To see the metered copy,
     temporarily un-comp (then re-comp when done):
     ```sql
     -- un-comp to see real dollars + runway
     update athlete_credits c set comped = false
     from athletes a join users u on a.user_id = u.id
     where c.athlete_id = a.id and a.user_id = u.id
       and u.email = 'davidjtemple@gmail.com' and a.telegram_chat_id like '-%';
     ```
6. **`/help`** → command list + the credits disclosure.

Watch the ledger from the CLI at any point:

```bash
npx tsx scripts/verify-stripe.ts --balance <athlete_id>
```

## Cleanup

```sql
-- Re-comp the test athlete if you un-comped it.
update athlete_credits c set comped = true
from athletes a join users u on a.user_id = u.id
where c.athlete_id = a.id and a.user_id = u.id
  and u.email = 'davidjtemple@gmail.com' and a.telegram_chat_id like '-%';
```

Refunding the test charge is optional — do it from the Stripe **dashboard** (test
mode) if you want to exercise the `charge.refunded` mirror; the webhook will post a
`kind=refund` row and drop the balance.

## Notes

- The buy/balance loop works **while comped** — topups credit regardless of comp.
  Un-comping only changes what `/balance` *displays* and whether the draw-down meters.
- **The command menu** (`/buy` etc. in the BotFather list) is set by
  `npm run commands:register`, which targets whatever token is in `.env.local`. During
  a test session that's the **staging** bot — handy for eyeballing the menu in the
  group. To push the menu to the **real** bot for friends, run it with the real token:
  `TELEGRAM_BOT_TOKEN=<real> npm run commands:register`.
- The daily cron skips the test athlete (negative chat id), so nothing else fires
  against it between sessions.
