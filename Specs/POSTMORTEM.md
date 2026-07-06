# Daybreak postmortem

**Written 2026-07-06, five days after the pause decision. Status: paused, not dead.** Everything still runs — the Fly worker, the daily cron, the web app. David is the remaining daily user. This doc exists for whoever picks the project back up (probably David, in a few weeks or a few years) and needs to know why it stopped, what it proved, and where the restart paths are.

---

## 1. What happened

Daybreak's only data source is Strava (`activity:read_all`, a v1 scope lock — no manual fallback by design). Strava caps API apps at a small athlete count by default; growing past ~10 friends required applying to Strava for more seats.

The timeline:

- At the start of the build (May 2026), the product passed Strava's API policy as it then stood.
- During the build, Strava updated the policy. Nobody re-read it. The Day 0.1 task list had "read the ToS, write a kill criterion" on it, and the deferred-questions list carried "Strava ToS — could affect scope" for 83 sessions. The initial read happened; the *re*-read when the terms changed did not, and the kill criterion was never written down.
- Late June 2026: the application for more than ten seats was rejected. No reason given — boilerplate copy pointing back at the API policy. Strava does not explain rejections and there is no appeal channel worth the name.

**Best-guess cause, not confirmed:** the updated policy's restriction on passing athlete data to third-party AI/LLM services — which is the entire coaching loop. It is possible the rejection was for something else entirely. There is no way to know.

The rejection wasn't a shutdown order. The app keeps working for up to ten athletes. What it killed was the growth path — and the growth path was the point.

## 2. Why pause instead of running small

Running for ≤10 friends is technically fine and was seriously considered. The reasons against:

- **The economics don't close.** Every athlete costs real Anthropic API money daily. With no path past ten users there's no way to recoup it, and no version of "impressive scaled product" to show a future employer or build a business on.
- **Payments and metering are built but untested.** Charging one or two friends would mean validating the whole Stripe/credits/billing-gate stack (`BILLING_GATE_ENABLED` was never flipped on) — real work in service of something that can't grow.
- **The July 1 deadline.** The standing rule was: move to projects with money-making potential by July 1. Daybreak was the most fun David has had building a product, which is exactly why the deadline existed.
- **The space is crowded.** Runna, TrainAsONE, Coopah, every AI-coach startup, plus people doing what one survey respondent described — just using Claude directly. Differentiation was already an open question before the API door closed.

So: on ice for a couple of weeks at minimum, then reevaluate. If a friend asks to be turned back on, the answer is "maybe, if you pay," and the payment stack would have to be tested first.

## 3. What the product got right

Learnings to carry forward, whatever form a revival takes:

1. **The daily adaptive prehab/strength push is the crown jewel.** A push notification with exercises and stretches tailored to your recent training history exists nowhere else. The adaptability — it knows what you actually ran, not what you planned — is what made it compelling. The injury-prevention angle landed with people for the same reason.
2. **Calendar sync mattered more than expected.** Coach edits a workout → your Google Calendar updates. One survey respondent called it out unprompted as a favorite.
3. **Persistent context is the real moat over raw Claude.** LLM-fluent users already do fitness planning in chat threads; their problem is context splitting across threads and re-pasting their data every time. Daybreak working *passively* — the context is just there, every day — was the differentiator, and one respondent said exactly this.
4. **The form factor is separable from the value.** None of the above requires Telegram. It could be an app. It could plausibly be a daily email.

## 4. What the survey said

Four responses to the shutdown survey (2026-07-01; raw CSV at `docs/daybreak-feedback-2026-07-01.csv`). Disappointment: one "very," three "a little."

**Confirmed the value props:** the conversational, always-editable plan ("as soon as [plans on other AI platforms] are built, they are static"); chat as the natural interface for goals; passive context ("pushes me to be more balanced in my training"); calendar sync; adaptability across changing goals.

**Criticisms worth taking seriously:**

- **Plan quality was the weak spot.** One respondent: the generated plans "always seemed slightly off or overly complicated," so they ignored the daily schedule and used the bot as a consultant instead ("I had to change plans, should I do 7 miles today given what I've done this week?"). Notably, the consultant mode still worked for them — which points at §7's plan-free direction.
- **Differentiation vs. plain Claude was not obvious to users.** Same respondent: "I wasn't entirely sure why to keep using Daybreak instead of Claude." The context moat is real but was not legible.
- **Telegram was a liability.** "I hate using Telegram... have to pay to block obvious spam. A separate app would be nice."
- **The engagement-question behavior grated.** Two respondents independently flagged the bot asking chatty follow-ups ("what trail do you want to run," "where are you going on vacation") — though one noted it stopped when asked, and counted that responsiveness as a positive.

One respondent floated building a Strava-data-liberation layer as its own product. Filed under ideas.

## 5. What I'd do differently

- **Re-check platform policy on every update, mechanically.** The lesson is not "read the ToS first" — that happened. It's that a platform dependency needs a standing tripwire: when the provider changes terms, that's a stop-and-read event. A calendar reminder would have done it.
- **Write the kill criterion down.** It was a Day 0.1 task and it never got written. The project ended up with an implicit one (can't grow past 10 = not worth running) that only got articulated the day it fired.
- **Treat a discretionary approval gate as a risk, not a formality.** The entire growth plan ran through Strava choosing to grant seats — a company with every incentive to say no to an AI coaching product built on their data. That risk was visible from day one and never priced in.
- **Single data source was the spec'd choice and the single point of failure.** "Strava required, no manual fallback" kept v1 simple, and it also meant one policy change ended the project. A revival should start from a multi-source posture (see §6).

## 6. Paths back to health data

The blocker is data access, not code. Options, roughly in order of current appeal:

- **Terra (tryterra.co)** — aggregator API over Garmin, Apple HealthKit, Fitbit, and others. Paid, but early research suggests free tiers / cheap ways in exist. One integration, many sources — directly fixes the single-point-of-failure lesson. Needs a real pricing and ToS read (see §5, tripwire included this time).
- **Apple HealthKit directly** — a strong path, but HealthKit data access effectively requires shipping an iOS app. Which is also what the survey asked for, and where the mini-app ideas (§7) want to live anyway. Biggest lift, most aligned with where the product wanted to go.
- **Garmin Connect Developer Program** — official API only (scraping stays an anti-goal). Would need an application and approval; same discretionary-gate shape as Strava, weigh accordingly.
- **Strava relenting** — not worth waiting on. No communication channel, no timeline, no reason to expect it.

## 7. If it comes back: the backlog

Projects that were on deck or that this pause crystallized:

- **Ultras beyond 50k.** U2 in `Specs/ULTRA_SUPPORT.md` — 50mi/100k/100mi archetypes and the back-to-back long-run renderer work. Never built; Chase's 44-miler ran on a marathon proxy.
- **Mini-apps for prehab/strength checklists.** Tappable checklists so completion data flows *back* to the agent — closing the loop on the product's strongest feature, which today is push-only.
- **A full training-plan view** athletes can actually browse (the read-only web plan page was minimal).
- **The plan-free version — the big one.** Daybreak was built training-plan-centric: everything serves keeping you on plan toward an event. There's a compelling version with no plan at all: look at recent activity history and issue a daily "here's what to do today" against generic goals — strength, endurance, balance, durability — no event required. The survey respondent who ignored their plan but loved the consultant mode is the early evidence. Ironically, v4 deliberately off-ramped no-event athletes; this version inverts that and makes them the center.

## 8. Bottom line

The product worked. Four friends used it daily, the coaching loop ran clean for weeks, and the parts that were hard to build — the adaptive daily push, the agent-over-files architecture, the onboarding engine with its eval harness — all held up. It died of a platform dependency: a mid-flight policy change at the sole data source, discovered via an unexplained seat-cap rejection, with no recourse.

It was also the most fun David has had building a product. That's worth something, and it's why this is a pause and not a burial. The restart requires two things: a data source that isn't Strava, and an honest answer to whether this crowded space has room for the thing Daybreak actually proved — not another plan generator, but a daily coach that already knows your context.
