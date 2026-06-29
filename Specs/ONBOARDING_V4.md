# Onboarding v4 — event-scoped product

_Status: **SIGNED OFF 2026-06-24.** This doc is source-of-truth for the v4
direction; the §11 coordinated edits are applied. Build status: **V4-W2 (the
dormant state + entry off-ramp) and the V4-W1 framing slice are built and on `main`**
(CHANGELOG v0.7.40 — the authoritative build record; web-only, push to Vercel, no
`fly deploy`; migration `20260625000000` to apply to prod). **W3 (post-event pause
+ re-activation) is fully built** (W3a v0.7.42, W3b v0.7.44). **Remaining and
unscheduled:** W1's substantive `event_kind`/adventure-fill pieces (fold into W4),
W4 (U1 catalog), W5 (web copy), W6 (eval harness — launch gate); U2 deferred (§6). This supersedes the no-event routing in `ONBOARDING_V3.md`
(Decision 8) and shelves `GENERAL_FITNESS.md`; it reconciles with `ULTRA_SUPPORT.md`
rather than duplicating it. The v3 slot-filling engine, chips, recap, numeric
handling, and `/edit_profile` are unchanged — v4 changes **what the product is
for**, not how a slot gets filled._

_Chip policy — when a button earns its place, and the eval chip-linter that enforces
it — lives in `Specs/ONBOARDING_CHIPS.md` (signed off 2026-06-29), the durable,
version-independent source of truth for chips._

_Author context: v3 made onboarding a good conversation. v4 narrows what that
conversation is for. The observed problem (David, June 2026): athletes who join
without something to train for don't retain and don't have a good experience.
The structural reason that's not a coincidence is in §1. v4 sharpens the product
to dated efforts — races and adventures — and turns the no-event paths into a
clean off-ramp instead of a half-supported plan._

---

## 1. Why v4 — the observed problem and the structural reason

**Observed (David's evidence, not a hypothesis).** Athletes who onboard with no
goal to train for aren't retaining and aren't having good experiences. The whole
product is built to generate a training plan, and a plan only means something
when it's built toward a specific dated effort.

**Structural (why that's not a coincidence).** A plan in this codebase *is* an
event artifact. `plan-schema.ts` requires `metadata.race` — a date and a
distance — and the renderer builds `base → build → peak → taper → race` toward
that date. There is no plan shape that isn't pointed at a dated effort. The
no-event path only renders at all by carrying a **synthetic placeholder race**
(`selector.ts` `DISTANCE_MILES.keep_fit = 5`), dropping the peak/taper phases,
and emitting an open-ended rolling block. So the no-event experience has always
been a workaround wearing a plan's clothes. v4 stops shipping the workaround as
if it were the product.

**The reframe: "event," not "race."** The unit is a single **dated effort at a
distance that the plan tapers toward**. Two kinds, adopting `ULTRA_SUPPORT.md`
§3.5 vocabulary so nothing new is invented:

- **`event_kind: race`** — an official race, looked up or athlete-named (5k →
  marathon, and ultras).
- **`event_kind: adventure`** — a personal objective with a date + distance that
  isn't an official race: Chase's 44-mile Rae Lakes Loop, David's ~20-mile
  mid-July run, a friend's 30-mile birthday effort. A real goal, structured like
  one.

**The boundary test is one question: is there a single day you're pointing at?**
A fuzzy day still counts ("mid-July," "September" → a mid-month placeholder, the
mechanism `ULTRA_SUPPORT.md` §3.5 already specs). A *rate* with no day — "20
miles a week," "just stay fit" — does not. That's the off-ramp (§4, §5).

---

## 2. Decisions (resolved with David, 2026-06-24)

The body reflects these; kept here as the decision record in the `ONBOARDING_V3`
style.

1. **Retire the `keep_fit` plan for v1.** The no-event rolling plan
   (`base-maintenance` / `goal_state = 'day_to_day'`) has no live path in v4:
   off-ramped at intake, paused (not maintained) after an event. Code is **left
   in place, not ripped out** — it may return in a later version. v1 (the
   milestone where Daybreak opens to more users) is **dated events and
   adventures only**. (§5)
2. **`intended` stays IN.** A single effort at a distance with no locked date is
   an event, date pending — it builds the existing block and binds the date
   later. Only a rate-with-no-effort off-ramps. (§3)
3. **Catalog scope is U1 only.** Build the four ultra buckets, `ultra-50k`,
   non-race adventures, fuzzy dates, and distance-derived plausibility — real
   plans for any event up to ~40 miles. **50mi+ (U2) is deferred** with an
   explicit pointer (§6); those efforts are recognized as real goals but get an
   honest proxy plan with consent until U2. (§6)
4. **Off-ramp = honest message + a scheduled check-back.** A no-event signup is
   told plainly what Daybreak is for, then asked when to check back — chips **1
   month / 3 months / 6 months** (typing "don't bother" is always allowed). The
   nudge fires once via the existing Vercel cron / `job_queue` path. (§4.3)
5. **Post-event = pause, not maintenance.** After an event completes, daily
   check-ins stop, the bot still answers questions, and committing a new event
   resumes dailies. No rolling plan. (§4.4)
6. **Existing athletes: upgrade Chase, hand-handle Anjie.** Chase's 44-mile goal
   becomes a first-class `adventure` when the catalog lands; David tells Anjie
   (the one genuine `keep_fit` athlete) the new scope and has her `/restart`. No
   automated migration. (§7)
7. **Positioning copy: tone signed off, words deferred.** The framing in §8 is
   approved in tone; David wordsmiths the exact strings. The load-bearing phrase
   to preserve is **"a race, or a personal adventure with a date."** (§8)
8. **Doc structure.** New `ONBOARDING_V4.md` as the primary artifact;
   `ULTRA_SUPPORT.md` reconciled in place; `SPEC.md` §3.9 + a `CHANGELOG.md`
   entry; `CLAUDE.md` §4; `GENERAL_FITNESS.md` shelved. (§11)

---

## 3. The event model and the goal-state boundary

v4 maps cleanly onto the three `goal_state` values the code already has
(`selector.ts:124` — `'committed' | 'intended' | 'day_to_day'`):

| `goal_state` | What it is | v4 status |
|---|---|---|
| `committed` | A dated race or adventure (date may be a fuzzy placeholder) | **IN — first-class** |
| `intended` | A distance + a single effort in mind, date not locked | **IN — event, date pending** |
| `day_to_day` (`keep_fit`) | No distance, no day — a rate or "stay fit" | **OFF-RAMP** (§4.3) |

The narrowing is mostly one move: **flip the `keep_fit`-entry route from
"route in" to "off-ramp," and leave `committed` and `intended` exactly as they
are.** `event_kind` (`race | adventure`) is orthogonal to `goal_state` — it
rides on the `races` row (`ULTRA_SUPPORT.md` §3.5) and only changes race-week
copy ("your run" vs. "your race"), never the plan structure.

**Why `intended` stays in (the boundary pressure-test).** "A half this fall, no
date yet" is still a single effort at a distance — there's one day being aimed
at, just unscheduled. It builds the existing ~12-week block toward a placeholder
and binds the real date later. What off-ramps is the absence of any single
effort: a weekly/monthly volume number, or "keep me fit," where there's no day
and nothing to taper toward. The line is the *effort*, not the *date*.

**Two off-ramp cases already behave correctly and stay as-is:**

- **Broad non-running fitness** ("I'm not really a runner — weight loss,
  lifting") → the honest "I'm a running coach" boundary (`ONBOARDING_V3.md` §4
  Opener 1). v4 makes this one instance of a general off-ramp pattern, not a
  special case.
- **Periodic volume goals** ("20 miles a week") → already get an off-ramp via
  Reflection R2 ("acknowledge, can't-help-yet, redirect," shipped v0.7.35). v4
  routes these to the same honest off-ramp + check-back as any no-event signup,
  rather than the v3 uncatalogued-goal pocket trying to proxy them.

So the genuinely new off-ramp work is narrow: the "just stay fit, no event"
case, which today routes *into* `base-maintenance` and now off-ramps instead.

---

## 4. The flow

Phases A0/A1 (link + Strava OAuth) are unchanged. The v3 slot-filling engine,
chips, recap, and numeric handling are unchanged. v4 changes the framing the
athlete meets and adds two exits (off-ramp, pause).

### 4.1 Expectation set before the first question

The positioning is established before Opener 1 so a no-event athlete
self-selects toward the off-ramp instead of being surprised by it. Two surfaces
(copy in §8):

- **The bot orientation** (post-Strava, `strava-resume.ts`) names the event as
  the first topic: "First I'll ask what you're training for — a race, or a
  personal goal with a date." This is the one line that does the work.
- **The web home page and signup** carry the same framing (§8) so the
  expectation is set before the athlete ever reaches Telegram.

### 4.2 Opener 1, reframed

"What are you training for — and do you have a race in mind?" becomes event-led:
the goal can be a race *or* an adventure with a date. The extractor already
fills `goal_type`, `goal_distance`, race/adventure name + date. New: when the
athlete names a personal objective (no `lookupRace` hit), the engine fills
`goal_race`/`goal_date`/`distance_mi` from their words with `event_kind:
adventure` and one inline confirm (`ULTRA_SUPPORT.md` §3.5 athlete-stated fill).
Fuzzy dates resolve to a mid-month placeholder.

### 4.3 The entry off-ramp (no-event signup)

When the athlete's goal resolves to a rate / "stay fit" with no single dated
effort, the bot does **not** route into a plan. It:

1. **Says plainly what Daybreak is for** (Daybreak voice, no hedging, no
   sycophancy). Draft (David to wordsmith):

   > I'll be straight with you: Daybreak is built around training for something —
   > a race, or a personal goal with a date and a distance. A friend's 30-mile
   > birthday run counts. "Get faster this year" doesn't quite, because there's
   > no day for me to build toward.
   >
   > What I do is ramp your training and taper it so you show up ready on the
   > day. No day, and I'm just sending easy runs you don't need an app for.
   >
   > Anything on your radar, even loosely? A distance you've been eyeing, a trip
   > with some long days in it? Tell me and we'll start there. If not, all good.

2. **Offers a path back in.** If they name even a loose goal, re-open Opener 1 to
   catch it (a loosely-held goal is still an event, date pending → `intended`).

3. **Captures a scheduled check-back** if they have nothing yet: "Want me to
   check back when something's on the calendar — when?" with chips **`[In a
   month]` `[In 3 months]` `[In 6 months]`** (typing "don't bother" ends it
   cleanly, per v3 principle 2 — chips and text interchangeable). The chosen
   interval writes a `check_back_at` date; a single nudge fires at that date via
   the existing Vercel cron → `job_queue` → worker path (no new infra, no
   anti-goal reopened). The nudge is one-shot; it does not repeat.

The off-ramped athlete is a linked athlete (Strava already connected) with **no
plan**, in the dormant state (§4.5).

> **Trigger fixed (v0.7.53, 2026-06-26).** As first built, this machinery only fired when
> the model emitted a `generate`-with-`general_fitness` or a `volume_goal` signal — but the
> engine prompt told the model to "hold the line" and never settle into `general_fitness`,
> so a plain conversational "just stay fit" got a goodbye and **never went dormant / never
> captured a check-back / never alerted David**. The V4-W6 eval caught it. Fix: a
> `general_fitness` `generate` now bypasses the plan-input gates and falls straight through
> to this off-ramp, and the prompt routes a confirmed no-event athlete here. See
> CHANGELOG v0.7.53.

### 4.4 The post-event pause

When a `committed` event's date passes and the plan's dated days are exhausted,
the athlete enters the **pause**, not a maintenance plan:

1. **Daily check-ins stop.** The daily cron skips paused athletes — no workout
   against a finish line already crossed.
2. **Q&A stays open.** Inbound messages still get coached (the existing ad-hoc
   run path), so the relationship persists between events.
3. **A new event resumes everything.** When the athlete names their next event
   (in chat or via `/edit_profile`), it commits a new `races` row + plan and
   dailies resume.

Draft pause message (David to wordsmith):

> That's States done — and you held it together through the canyons, which is the
> part that breaks people.
>
> I'm going to ease off the daily check-ins now. There's no finish line in front
> of you, so a workout every morning would just be noise. I'm still right here —
> ask me anything, talk through how it went, or check in whenever.
>
> When the next one lands on your calendar — race, adventure, whatever pulls you —
> tell me and I'll build the block for it. Enjoy the recovery. You earned the
> quiet.

The pause is passive: no scheduled nudge (unlike the entry off-ramp), because the
athlete has an established relationship and will return when they have a goal.
(A scheduled post-event nudge is a possible later addition, not v1.)

### 4.5 The dormant state (one state, two doors)

The entry off-ramp and the post-event pause converge on **one dormant athlete
state**: row intact, Strava connected, daily cron skips them, inbound messages
still coached, **no plan**. Reached two ways (off-ramp at intake, or pause after
an event), exited one way (commit an event → plan renders → dailies resume).
Implementation mechanism (a new `goal_state` value such as `paused`/`dormant`, or
an athlete-level flag + `check_back_at`) is left to the build; the spec fixes the
*behavior* and the single re-activation trigger.

---

## 5. What v4 retires

- **The `keep_fit` plan path.** `base-maintenance` selection, the `day_to_day`
  plan state, and the synthetic placeholder race for no-event athletes have no
  live path in v4. **Code stays in place (dormant), not deleted** — revivable in
  a later version (Decision 1).
- **`GENERAL_FITNESS.md` is shelved.** Its thesis (keep_fit as the between-races
  retention engine) is the bet v4 declines. **GF-W1** (open-ended plan
  extension, shipped v0.7.32) and **GF-W2** (no-race daily narrative, shipped
  v0.7.33) are **superseded**: nothing in v4 produces a `day_to_day` athlete, so
  neither runs. The shipped code can sit dormant; ripping it out is optional
  cleanup, not a v4 gate. GF-W3–W7 (unbuilt) are not built. A future session
  must not build on top of GENERAL_FITNESS without first un-shelving it with
  David.
- **The v3 "route a no-race athlete into `keep_fit`" decision** (`ONBOARDING_V3`
  Decision 8) is reversed for entry. The honest non-running-fitness boundary it
  preserved still stands — now as part of the general off-ramp.

What is **not** retired: the v3 engine, chips, recap, numeric/plausibility layer,
`/edit_profile`, the uncatalogued-goal pocket (it still catches genuinely
unstructurable shapes), Strava-required, Telegram-only, template-first plan-gen.

---

## 6. Catalog scope — adopt `ULTRA_SUPPORT.md` U1, defer U2

v4 pulls the event-catalog half from `ULTRA_SUPPORT.md` and locks the scope:

**In v1 (U1):** the four buckets (`50k / 50mi / 100k / 100mi` as internal
training archetypes), the `ultra-50k` template (a long trail marathon reusing
existing machinery — no renderer changes), non-race adventures (`event_kind`,
athlete-stated fill, fuzzy dates), and distance-derived finish-time plausibility.
The deterministic bucket-from-`distance_mi` derivation already shipped (V3-W8);
U1 widens the bands so ultra distances resolve instead of pocketing.

**Coverage with U1:** a real, structured plan for any event **up to ~40 miles** —
5k through marathon, the new `ultra-50k` (~31mi), and any adventure in that range
(David's mid-July 20-miler is marathon-band; a 50k friend is `ultra-50k`).

**Deferred — the 50mi+ pointer (U2).** Efforts of ~40 miles and up
(`50mi / 100k / 100mi` buckets, the `ultra-endurance` template) need renderer
features the engine doesn't have — **back-to-back weekend long runs** and
**time-on-feet (hours, not miles) long runs**. That work is **deferred to a
later version**, recorded here so it isn't lost. Until U2:

- 50mi+ goals are recognized as **real events** (`event_kind`, real distance and
  date stored in the athlete's words) — never wedged.
- The **plan** is an honest **proxy with consent** via the uncatalogued-goal
  pocket (`ONBOARDING_V3.md` §5.2): "A 44-mile mountain run is past what I can
  build a structured plan for right now — I top out around the marathon. What I
  can do: build toward [nearest in-catalog structure] and coach you toward the
  44 as your north star. Want that?"

**Live impact of deferring U2:** exactly one current athlete — **Chase**
(44-mile Rae Lakes, Sept 18, ~12 weeks out). His goal becomes first-class
(`adventure`), his plan stays a hilly-trail-marathon proxy until U2. David's own
Western States 100 is also U2, but it's June 27 (days out) — a test re-onboard,
not a live planning need. If Chase's proxy proves insufficient before Sept 18,
U2 is the fast-follow (it was scoped, not built).

---

## 7. Existing-athlete handling

Friends-only, a handful of people; no automated migration.

- **Chase** — currently jammed into a marathon proxy via the pocket. When the U1
  catalog lands he's **upgraded to a first-class `adventure`**: real distance
  (44mi), real September date, `event_kind: adventure`, no longer wedged. Plan
  stays the proxy until U2 (§6). Net improvement for him on day one.
- **Anjie** — the one genuine `keep_fit` (`day_to_day`) athlete (hand-fixed
  2026-06-10). David **tells her the new scope directly and has her `/restart`.**
  If she re-onboards still event-less, she meets the same off-ramp as any new
  signup — which is the intended behavior.
- **Everyone else** — race/marathon goals, unaffected.

---

## 8. Positioning copy (tone approved 2026-06-24; David wordsmiths the strings)

All public-facing event framing in one place. Tone is signed off; exact wording
is David's. The phrase to preserve across surfaces: **"a race, or a personal
adventure with a date"** — it makes adventures legible and sends no-event
athletes toward the off-ramp on their own. Per `CLAUDE.md` §3, none of this may
read as AI-generated; no sycophancy; no "that's not X, that's Y"; avoid
"genuinely / honestly / straightforward / niggle."

**Taxonomy note for the copy:** *event* is the umbrella; *race* and *adventure*
are its two kinds. Don't list three parallel near-synonyms ("a race or an event
or an adventure" — race and event overlap). The clean shape is "an event: a race,
or an adventure with a date."

**Web home page (`src/app/page.tsx`):**

- **H1** (line 36): "Your race goals." → "Your event." (e.g. "Your event. Your
  schedule. Your injuries. Daybreak makes it work.")
- **Lede** (line 38): broaden "a race training companion" to event/adventure
  while keeping the injury hook. Draft:
  > Daybreak builds your training around one thing: your next event — a race, or
  > a personal adventure with a date on it. It reads your Strava and helps you
  > make the right call each day, around injuries, soreness, and a packed
  > schedule.
- **"What it does" / how-it-works section** (`#how`, the `plan` row, line 60):
  state plainly that this is free training for an event. Draft:
  > **plan** — Free training for your event — a race, or an adventure with a
  > date. Built around your schedule and where your fitness actually is.
  - **Accuracy flag on "free":** it's free for the first group of friends, then
    prepaid. Tie the how-it-works "free" to the existing honest hero-note framing
    ("Free to start, then pay only for the AI tokens you use," line 50) rather
    than a flat "it's free," so the page doesn't promise permanence the billing
    model doesn't.

**Signup page (`src/app/signup/page.tsx`):**

- Headline (line 182): "Let's get you running." → event-forward. Directions
  David liked in tone: "Train for your next event." / "Every plan starts with a
  date." / "Point at a race. Or a wild idea. We'll get you there." (the last one
  earns the adventure half). David to choose/wordsmith.
- The waitlist "What are you training for?" already fits; leave it.

**Bot welcome (`bot.ts` ~line 87):** unchanged in substance (Strava-connect CTA).

**Bot orientation (`strava-resume.ts` ~line 29):** name the event as topic one:
> Okay {firstname}, let's get you set up. First I'll ask what you're training for
> — a race, or a personal goal with a date, like a big trail day with friends.
> Then where your training's at now, and any injuries to keep an eye on. [...]

**Engine flow rules (`extract-and-advance.ts`):** "goal + race" → "goal + event";
`goal_type` enum framing reflects race/adventure as event kinds (the
`event_kind` plumbing is `ULTRA_SUPPORT.md` §3.5).

---

## 9. Eval / verification — narrowed but event-broadened

> **Built (V4-W6, 2026-06-26, v0.7.53; gate 14/18) — see §10 + CHANGELOG v0.7.53.** Two
> refinements the build settled, vs the assertion list below: (1) **"provenance never
> `stated` for the unstated" is a JUDGE dimension, not a deterministic gate** — a
> facts-substring match false-positives on model-resolved dates, looked-up race dates,
> composed goal labels, and "nothing"→"none" normalizations (all faithful, not invented),
> so fabrication is checked by the optional `--judge` pass, not the hard gate. (2) The
> **general-fitness / broad-non-running off-ramp** assertions required the §4.3 trigger fix
> to fire at all (the machinery was unreachable on the conversational path) — now verified.
> **Open before launch-gate-clean:** the `target_time` numeric fix
> (`TARGET_TIME_PACE_FIX_PROMPT.md`) and two fixture tweaks (`beyond-50k` persona,
> `injury-skipper` `[Skip]` pin).

> **Superseded for beyond-50k (V4-W4, 2026-06-24, v0.7.46).** The "consented proxy
> for a 50mi+ goal" fixtures below (the 44-mile adventure, Western States 100) were
> built as an **off-ramp**, not a proxy: a goal past the 50k is acknowledged and
> redirected to a shorter event, with no proxy plan. The **50k race → real `ultra-50k`
> plan** fixture stands as written. The `event_kind: adventure` fixtures are W4b.

The v3 eval set (`ONBOARDING_V3.md` §7) is the base. v4's job is **net different,
not simpler**: ultras and adventures add fixtures while no-event ones convert.
This set is a launch gate for opening to more users (mirrors the V3-W5 gate).

**Keep verbatim (structural, goal-agnostic):** chatty over-answerer, terse
one-word-per-turn, voice-disfluent, adversarial "why do you need this,"
cold-start/no-Strava, injured, injury-skipper (`[Skip]` → `unknown`),
messy-time-goal ("10 minute miles for a marathon," "4:25"), safety-contradiction,
confirm-loop replay, goal-change (date must not survive).

**Convert (the no-event fixtures change their expected behavior):**

- **General-fitness / no-race-ever** — was "routes to `keep_fit`, plan promises
  no race/taper." **Now:** gets the **entry off-ramp** — no plan generated, the
  honest message fires, and a check-back interval is captured (or a clean stop on
  "don't bother").
- **Broad non-running** — stays an off-ramp assertion (the "I'm a running coach"
  boundary), now consistent with the general off-ramp rather than a one-off.
- **Volume goal** ("20 miles a week") — **now** routes to the off-ramp +
  check-back, not the pocket's proxy attempt.

**Add (event-broadened).** _Adventure fixtures BUILT (W4b, 2026-06-25, v0.7.47) —
amended to the off-ramp reconciliation: a beyond-50k adventure off-ramps, it does
not proxy._

- **Beyond-50k adventure → off-ramp** — Chase's profile: 44mi, "September,"
  ~15mi/wk, 3 days, long-standing right ITB. Asserts: `event_kind: adventure`
  cleared at the off-ramp; athlete-stated (no `lookupRace` hit); 44mi recognized
  as past the catalog → the **W4 off-ramp** (acknowledge, state the 50k ceiling,
  ask for a shorter event), **no proxy plan, no race row**, the goal rides as an
  intent. (The pre-W4 "consented proxy" expectation is retired.)
- **Sub-40 adventure that gets a real plan** — David's mid-July ~20-miler:
  `event_kind: adventure`, marathon-band, a **real structured plan** (proof the
  adventure path isn't a proxy); a 33-mile route → `ultra-50k`, real distance (33)
  on the row, fuzzy "September" → the 15th. Athlete-stated fill, one confirm.
- **not_found disambiguation** — a named-but-unfound query (the Dipsea): asks
  "organized race, or your own thing?" (two chips), pre-fills `goal_race`, never
  dead-ends; the answer sets `event_kind`.
- **Ultra race** — Western States 100: `event_kind: race`, looked up, 100mi
  recognized → off-ramp (no proxy until U2), no enum wedge (the V3-W8 / U1 fix).
- **50k race** — `ultra-50k` template selected, real plan, effort-led paces, no
  time-goal pace driver.

**Assertions carried from v3 plus v4-specific:** no `generate` with a
required-core slot unfilled; injury beat always asked; provenance never `stated`
for the unstated; a confirmed race's `distance_mi` sets `goal_distance` in code;
**a no-event goal produces the off-ramp (no plan) + a captured check-back or
clean stop — never a `keep_fit` plan**; **an `event_kind: adventure` goal fills
from the athlete's words with one confirm**; **a fuzzy date resolves to a
mid-month (the 15th) ISO date, not a rejection**; **a beyond-50k goal (race or
adventure) off-ramps — no proxy, never wedges, never silently writes the nearest
bucket**.

---

## 10. Execution plan (workstreams, unscheduled — for a future build session)

Sizes S/M/L = hours / a day / multi-day. v4 reuses the v3 engine; most work is
framing, the off-ramp/pause state, and adopting U1.

- **V4-W1 · Event framing + Opener 1 reframe · S/M.** ⚙️ **Framing slice BUILT**
  (2026-06-24, v0.7.40): orientation + engine topic wording reframed to the event
  (DRAFT copy, David's voice pass pending). **Deferred to W4/U1:** `event_kind`
  surfaced in the recap + the `ULTRA_SUPPORT.md` §3.5 athlete-stated adventure fill
  — both need the `event_kind` column the catalog work builds (the W1/W4 split had
  this hidden dependency).
- **V4-W2 · The dormant state + entry off-ramp · M.** ✅ **BUILT** (2026-06-24,
  v0.7.40). The dormant athlete state (§4.5) via the existing pause primitive
  (`pause_reason='dormant'` + new `check_back_at`, not a new `goal_state`), the
  daily-cron skip (free), the off-ramp message + path-back (single intercept at
  `goal_type='general_fitness'`, two beats), and the `check_back_at` capture with a
  one-shot cron nudge (direct-send, like the auto-pause notice). Planless inbound
  re-opens the engine (Option A) with a written ack + gentle explanation.
- **V4-W3 · Post-event pause · M.** ⚙️ **W3a BUILT** (2026-06-24, v0.7.42):
  detect event-complete (committed + event date past + plan dated days spent, after
  one grounded race-day+1 run) → `enterDormant(id, null)` + static notice in the
  daily cron, before the inactivity scan; daily skip is free; Q&A stays open
  (verified — the finished plan is kept, so `bot.ts` routes inbound to the coach).
  Shares the dormant-state machinery with W2; web-only (Vercel push), no migration.
  ✅ **W3b BUILT** (2026-06-24, v0.7.44): a `/next_event` command resets any
  `complete` athlete to event-scoped intake behind a warn-and-confirm gate, then
  the engine's `finishOnboarding` does `exitDormant` + commit + a FRESH plan. The
  idempotency make-or-break is solved by `supersedeActiveTemplatePlan` (retire the
  old active version + null `current_version_id` so plan-gen renders new, not
  stale); the old race is marked `completed`; the dormant check-back / pause copy
  now points at `/next_event`. Web-only (Vercel push), no migration, no worker
  change. **W3 fully done.**
- **V4-W4 · Catalog U1 · M.** ⚙️ **Catalog slice BUILT** (2026-06-24, v0.7.46 — the
  authoritative record). Adopted `ULTRA_SUPPORT.md` U1, with two David decisions that
  diverge from the §6/§9 body below:
  - **Lean enum — only `50k`, not the four buckets.** `50mi/100k/100mi` are NOT in the
    enum: the total-record types would force them to map to a template that doesn't exist
    until U2, and the §3.2 ultra fallback rows never fire (50mi+ always carries a concrete
    distance → the pace-envelope path). The `ultra-50k` template, distance-derived
    plausibility (`deriveBucketFromMiles` 28–40→`50k`, `target_time` max→48h, `50k` finish
    band), and widened bands all landed.
  - **Beyond-50k OFF-RAMPS — it does NOT proxy.** Supersedes the §6/§9 "consented proxy
    for 50mi+" design: a 44-mile/100k/100mi goal is acknowledged, the 50k ceiling is stated,
    and the athlete is asked for a shorter event or tune-up to build around — no proxy plan,
    no keep_fit, no future-plan promise; the real goal rides as an intent. Same shape as the
    W2 no-event off-ramp.
  - Needed ONE small `goal_distance` CHECK migration (`20260626000000_goal_distance_50k.sql`).
  - **W4b BUILT** (2026-06-25, v0.7.47). The W1-deferred half landed: `races.event_kind`
    migration (`20260627000000_races_event_kind.sql`); the §3.5 athlete-stated **adventure
    fill** via a new `extract_and_advance` `event_kind` signal (a personal effort skips the
    lookup, fills `goal_race` from the athlete's words, ceiling-bounds through the existing
    `applyStatedDistance` so >40mi off-ramps); the not_found path now **disambiguates**
    (organized race vs your own thing) instead of dead-ending (David's refinement); the real
    stated distance rides to the row (`event_distance_mi`); fuzzy dates resolve to the 15th
    (mid-month ISO — not a non-ISO placeholder, which the `date` columns reject); the recap
    reads `event_kind` ("your run"). The §9 adventure fixtures landed. The worker race-week
    "your run vs your race" copy stays deferred (cosmetic, a `fly deploy`).
- **V4-W5 · Web positioning copy · S.** ✅ **BUILT** (2026-06-25, v0.7.49).
  Home page (`src/app/page.tsx`): H1 first beat `Your race goals.` → `Your event.`;
  lede dropped "race" (`a training companion`); the how-it-works `plan` row →
  `Creates a training plan for your race or adventure.`. **Signup headline left
  unchanged** (`Let's get you running.`) — David's call, a conscious DoD deviation.
  The `plan` row carries `race or adventure` but **drops "free"** (pricing stays in
  the hero-note — no forever-free promise). The full load-bearing phrase ("…with a
  date") lands on no web surface by choice; the bot orientation + Opener 1 do the
  no-event self-selection (verified event-scoped, left untouched). Web-only (Vercel
  push), no migration, build green + preview-verified.
- **V4-W6 · Eval harness + fixtures · M.** ⚙️ **BUILT + run live** (2026-06-26,
  v0.7.53). §9. The V3-W5 harness with the v4 deltas: a Vitest suite driving the real
  engine against live Sonnet, a hybrid simulated athlete, 18 fixtures, a deterministic
  gate + optional `--judge` (built from `V4_W6_PROMPT.md`). The first runs surfaced + fixed
  the §4.3 off-ramp trigger gap (prod) and shipped prompt caching (Part 1, prod); gate at
  **14/18**. **Launch-gate-clean pending:** the `target_time` numeric fix
  (`TARGET_TIME_PACE_FIX_PROMPT.md`) and two fixture tweaks (the `beyond-50k` persona, the
  `injury-skipper` `[Skip]` pin).
- **Retire / shelve · S.** Mark `GENERAL_FITNESS.md` shelved; note GF-W1/W2
  superseded; leave their code dormant (§5). Apply the §11 coordinated edits.

**Deferred (pointer, not v1):** **U2** — 50mi+ renderer work (back-to-back long
runs, time-on-feet), `ultra-endurance` template. Fast-follow candidate if Chase's
proxy is insufficient before Sept 18 (§6).

---

## 11. Spec governance — coordinated edits (apply only on sign-off)

Per `CLAUDE.md` §2, none of these are applied until David signs off. On sign-off:

- **`SPEC.md`** — a **`CHANGELOG.md` entry** (next version) records the approved
  v4 direction and is the authoritative interim record. **§3.9** gets a v4
  pointer note; its body is rewritten to the event-scoped flow as the
  workstreams land (the standing convention — the spec body never describes
  unbuilt code as current).
- **`CLAUDE.md` §4** — amend the onboarding scope-lock bullet: event-scoped
  intake, `keep_fit` off-ramped (not routed in), the dormant/pause state.
  **Unchanged locks:** Strava-required, Telegram-only, template-first plan-gen.
  Note the `keep_fit`-plan retirement.
- **`ULTRA_SUPPORT.md`** — reconciled in place, not duplicated: U1 is locked as
  v1 catalog scope; U2 carries the explicit "50mi+ deferred" pointer; v4 owns the
  event *framing* + off-ramp while ULTRA keeps owning catalog + plan-gen. Add a
  one-line cross-reference to this doc.
- **`GENERAL_FITNESS.md`** — a "**Shelved for v1 (2026-06-24) — superseded by
  `ONBOARDING_V4.md`; do not build on without un-shelving with David**" banner at
  the top. Not deleted.
- **`ONBOARDING_V3.md`** — Decision 8 marked reversed-for-entry by v4 (with a
  pointer); the rest of v3 stands (it's the engine v4 reuses).
- **No anti-goal reopened** (`CLAUDE.md` §5): no Inngest (the check-back nudge
  rides `job_queue`), no web onboarding, no manual-log fallback, no Garmin.

**Open for David at sign-off:** (a) final wording on all §8 copy; (b) the dormant
state's exact mechanism (new `goal_state` vs. flag) — a build-time call, not a
spec blocker; (c) whether to schedule U2 as a fast-follow now or wait on Chase's
proxy; (d) whether the §10 workstreams are sequenced now or parked until after
the eval harness.

If this shifts how Daybreak is positioned to others, David's personal wiki
(`~/projects/wiki`, the `[[david-temple]]` hub and any Daybreak page) may want a
matching note — secondary to this spec.
