# V4-W5 — web positioning copy (next implementation step)

_Paste this into a fresh session. It is self-contained; it assumes no memory of the
sessions that built V4-W4 / W4b._

## What you're building

**V4-W5: the web positioning copy** — reframe the public-facing web copy from
marathon/race-centric to **event-scoped** (a race, or a personal adventure with a
date), matching the v4 intake narrowing. The bot and engine framing already shipped
(the W1 framing slice, and W4b's `event_kind` work); W5 is the **web surface** that
still says "race."

Two pages, copy only:

- The **home page** (`src/app/page.tsx`) — H1, lede, the how-it-works "plan" row.
- The **signup page** (`src/app/signup/page.tsx`) — the invite-path headline.

**This is a copy task. The strings are David's to wordsmith.** §8 carries draft copy
as a starting point — propose 2–3 options per slot in David's voice, let him pick,
then apply. Do **not** unilaterally ship final marketing strings.

**Scope: web-only — commit → push (Vercel auto-deploys). NO migration, NO
`fly deploy`.** Size: S (hours).

## Read first (source of truth)

1. **`Specs/ONBOARDING_V4.md` §8** — the positioning-copy spec: the draft strings,
   the **taxonomy note**, and the **"free" accuracy flag**. This is the spec for W5.
2. **`CLAUDE.md` §3** — the hard rules for generated copy (must not read as
   AI-generated; no sycophancy; no "that's not X, that's Y"; follow the humanizer
   guidelines; avoid "genuinely / honestly / straightforward / niggle"). **Load-bearing
   for visitor-facing marketing copy** — this is exactly where an AI tell does the most
   damage.
3. **`Specs/ONBOARDING_V4.md` §10 V4-W5 line; §1 / §4** — why v4 narrowed to
   event-scoped, and why the phrase "a race, or a personal adventure with a date" is
   load-bearing (it makes adventures legible and sends a no-event athlete toward the
   off-ramp on their own).
4. **`CLAUDE.md` §5** (anti-goals — no component library / no marketing-page expansion;
   keep it minimalist Tailwind), **§9** (scoped unit — confirm before expanding),
   **§10** (git/deploy — `git status` first; the web tree sees concurrent sessions;
   commit + push when green).

## The load-bearing phrase + taxonomy

The phrase to preserve across surfaces: **"a race, or a personal adventure with a
date."** Taxonomy: **event** is the umbrella; **race** and **adventure** are its two
kinds. The clean shape is "an event: a race, or an adventure with a date." Do **not**
list three parallel near-synonyms ("a race or an event or an adventure" — race and
event overlap).

## The changes

### Home page (`src/app/page.tsx`)

- **H1** (currently ~line 36: `Your race goals. Your schedule. Your injuries. Daybreak
  makes it work.`) → event-framed. §8 draft: **"Your event. Your schedule. Your
  injuries. Daybreak makes it work."**
- **Lede** (currently ~line 39: `Daybreak is a race training companion for runners
  with busy schedules or nagging injuries...`) → broaden "a race training companion" to
  event/adventure, keep the Strava + injury/soreness/schedule hook. §8 draft:
  > Daybreak builds your training around one thing: your next event — a race, or a
  > personal adventure with a date on it. It reads your Strava and helps you make the
  > right call each day, around injuries, soreness, and a packed schedule.
- **How-it-works "plan" row** (`#how`, currently ~line 60–62: `Creates a training plan
  that fits your schedule and goals.`) → state plainly it's free training for an event.
  §8 draft:
  > **plan** — Free training for your event — a race, or an adventure with a date. Built
  > around your schedule and where your fitness actually is.
  - **Accuracy flag on "free":** it's free for the first group of friends, then prepaid.
    Tie this "free" to the existing honest hero-note (~line 50: "Free to start, then pay
    only for the AI tokens you use") so the page doesn't promise a permanence the billing
    model doesn't. Don't write a flat/forever "it's free."

### Signup page (`src/app/signup/page.tsx`)

- **The invite-path headline** (currently `Let's get you running.`, ~line 182 — line
  numbers drift, locate the string; it's the invited-athlete branch, not the
  `Get on the waitlist.` branch) → event-forward. §8 options David liked in tone:
  "Train for your next event." / "Every plan starts with a date." / "Point at a race.
  Or a wild idea. We'll get you there." (the last earns the adventure half). **David
  chooses / wordsmiths.**
- Leave the waitlist **"What are you training for?"** — it already fits.

## Already done — do NOT redo

§8 also lists bot welcome (`bot.ts`), bot orientation (`strava-resume.ts`), and engine
flow rules (`extract-and-advance.ts`). Those event-reframes **already shipped** (the W1
framing slice, session 70, CHANGELOG v0.7.40; plus W4b's `event_kind`). Verify they read
event-scoped; do **not** rewrite them. If you find a residual race-only phrasing there,
**flag it** — don't silently expand W5's scope into the bot/engine.

## Settle with David before shipping

- The final **H1**, **lede**, **how-it-works "plan"** line, and **signup headline**
  strings. Propose 2–3 options per slot in David's voice (the §8 drafts are the floor,
  not the ceiling); he picks. This is the whole point of W5 — the copy is his.

## Constraints / gotchas

- **Web-only — push (Vercel). NO migration, NO `fly deploy`.** If you reach for
  `worker/` or a migration, you're out of scope — stop and confirm.
- **`CLAUDE.md` §3 copy rules are hard.** Run the **humanizer** skill over every new
  string before shipping. No AI tells, no sycophancy, no "not X, but Y," none of the
  banned words.
- **Don't touch billing accuracy** — "free" stays tied to the honest hero-note.
- **Keep the surface minimalist** (`CLAUDE.md` §5): plain Tailwind, no component library,
  no new marketing sections — this is a copy swap, not a redesign.
- **Collision discipline** (`CLAUDE.md` §10): `git status` first; stage only the two
  page files; if foreign changes appear, stop and flag (other sessions edit this tree).

## Verify

- `npm run build` green (catches Turbopack asset errors `typecheck`/`lint`/`test` miss).
- **Browser-observable — verify it.** Start the preview, screenshot the **home page**
  (H1 / lede / how-it-works) and the **signup invite path**, confirm the event framing
  reads right and there are no AI tells. Share the screenshots — don't ask David to check
  manually.

## Definition of done

- Home **H1**, **lede**, and the how-it-works **"plan"** row read event-scoped (a race
  or an adventure), with "free" tied to the hero-note (no forever-free promise).
- The **signup invite headline** is event-forward.
- The phrase "a race, or a personal adventure with a date" (or David's chosen variant)
  lands on at least the lede.
- No AI tells; humanizer-clean; `CLAUDE.md` §3 honored.
- Bot/engine framing confirmed already-done and left untouched.
- `npm run build` green; preview screenshots shared.
- Commit + push (web auto-deploys). Update `Specs/CHANGELOG.md` (next version),
  `Specs/ONBOARDING_V4.md` §10 (W5 → built), `claude-status.md` per §8.

## After W5

- **Remaining v4: W6 / V3-W5 — the eval harness** (the V3-W5 harness with the v4
  fixture/assertion deltas in §9; the launch gate before opening to more users).
  **HELD by David — do not start it without his go-ahead.**
- **Deferred cosmetic:** the worker **race-week "your run" coach copy** (`worker/prompts/
  coach.md`, `event_kind`-aware taper/race-week tone) — a `fly deploy`, small. The
  readiness / Sunday-review / buildup-floor copy was already generalized to event-neutral
  (v0.7.48 / commit `94c03b4`); this is the remaining race-week bit.
- **DRAFT copy voice passes still open for David:** the W1/W3a off-ramp, check-back, and
  post-event-pause notices, and the onboarding-reflection copy.
