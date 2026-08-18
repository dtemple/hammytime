# Strava API compliance review — 2026-07-01

Prompted by the capacity-increase denial. Reviewed against the current Strava
[API Agreement](https://www.strava.com/legal/api) and
[API Policy](https://www.strava.com/legal/api_policy), both **Effective June 1, 2026**,
and the [Brand Guidelines](https://developers.strava.com/guidelines/) (rev. Sept 29, 2025).

## Bottom line

The "denied because I had 8 athletes, not 10" theory is wrong, and the real
problem is not fixable by tweaking the app. The June 1, 2026 Policy rewrite adds
explicit, categorical prohibitions on the mechanism Daybreak is built on:
feeding an athlete's Strava data into an LLM's context window to generate
coaching. Resubmitting the same architecture will not pass. A detailed
resubmission that accurately describes an LLM coach makes rejection *more*
likely, and a compliance audit (Agreement §6.2) could put the existing 10-athlete
token at risk.

The athlete-count theory is also mechanically wrong. The 10-user level **is** the
free Standard Tier hobbyist level — no approval needed up to 10 (Policy §3.3(a)).
The application was a request to go *beyond* 10, and the count at submission is
not the eligibility bar.

## The blocking clauses

These three are each independently fatal to the current design.

**Policy §5.3 — No AI operation, including context-window ingestion.**
"You may not use the Strava API Materials or Strava Data, directly or indirectly,
in connection with the development, training, evaluation, or operation of any AI
Application." The prohibition explicitly lists "ingestion into a context window
or working memory." Daybreak's worker pre-fetches Strava data to
`strava_recent.json` (`worker/folder.ts`) and hands it to the Claude Agent SDK
as agent input. That is the named prohibited act, verbatim. Pre-fetching instead
of giving the agent live API access does not help — the clause covers Strava Data
"directly or indirectly" and "any data derived from" it "in any form."

**Policy §5.10 — No transfer to AI providers, even with consent.**
"You may not, directly or indirectly, disclose, market, sell, license, lease, or
make available... any Strava Data to any third party — including advertisers, data
brokers, AI Application providers, or model developers — even if a user of your
Developer Application consents." Sending the folder contents to Anthropic's API is
disclosure of Strava Data to a model developer. Athlete consent does not cure it.

**Policy §5.16 — Strava MCP is the sole authorized agent interface.**
Prohibits operating "any MCP Server, agent-mediated interface, or analogous
mechanism that exposes the Strava API Materials, Strava Data, or any subset
thereof." The coaching agent is an agent-mediated interface over Strava Data.
§3.5 names the Strava MCP as the *only* sanctioned agent path, and restricts even
that to "a subscriber... in connection with their personal use of their own Strava
data" — "not authorized for... any commercial or third-party access." That carve-out
covers David coaching himself; it does not cover a multi-athlete service.

## Secondary issues (real, but moot while the above stand)

**§5.5 / §6.2 / §6.4 — Persistence of derived data.** 7-day cache cap; no
"Persistent Index"; retention limited to purpose. The `memory_files` rows
(latest-state, training log) persist indefinitely and, where they quote
Strava-derived figures ("ran 42 km last week"), that is derived Strava Data stored
past 7 days in a queryable store. Note: the *14-day lookback window* is fine —
the limit is on retention duration, not how far back a single fetch reads.

**§2.3 / §6.1 — Display limited to the authenticated athlete.** Under 9,999 users
you may show an athlete's data only to that athlete. Any admin review of the
`messages` table where coaching content embeds Strava-derived numbers shows one
athlete's data to David. Removing shadow-bcc (v0.7.3) was the right instinct; the
admin console reintroduces the same exposure.

**§5.8 — No end-user charges related to the API Materials.** The prepaid
pay-per-usage plan charges athletes for a service built around Strava data. There
is a carve-out for functionality "not provided by the Strava Platform and not
substantially duplicative" (coaching qualifies), so this is arguable — but the fee
funds LLM processing that §5.3 already prohibits upstream.

**§3.3 — Subscription requirement.** Standard Tier now requires the developer or
specified end users to hold an active Strava subscription. An eligibility item to
confirm, not the blocker.

**§7.3 — Developer privacy policy.** Must be GDPR/UK-GDPR-grade, prominently
linked, and disclose §6.5 usage-data monitoring. Confirm the web app has one.

## Why this happened

The June 1, 2026 Policy is a targeted anti-AI-scraping rewrite (following the
November 2024 update), timed with Strava's pre-IPO positioning. Whether one-shot
LLM inference — no training, athlete's own data — counts as prohibited "operation"
was raised on Strava's developer forum in May 2026 and has no public resolution.
Read literally, §5.3's "operation of any AI Application" and "ingestion into a
context window" cover it. Treat inference as prohibited absent written guidance.

## Options, with honest odds

1. **Ask Strava directly** (developers@strava.com) — describe the exact inference
   workflow (athlete's own data, no training, transient) and ask whether it's
   permitted or eligible for Extended Access. Legitimate channel, low odds, but it
   resolves the ambiguity in writing and is the only way to keep the API path alive.
   Do this *before* any resubmission.

2. **Re-architect off the API.** Have athletes use Strava's own user-facing Bulk
   Data Export (§6.6, a protected user right) or paste their own data, so Daybreak
   never touches "Strava API Materials." Athlete-initiated export is arguably
   outside the API terms entirely. This is the most plausible way to keep the
   product and the LLM coach — at the cost of the frictionless OAuth sync.

3. **Keep the LLM, drop Strava from its context.** Do deterministic (non-LLM)
   analysis of Strava numbers; feed the LLM only non-Strava-derived text. Hard to
   thread, because §5.3 covers data "derived from" Strava Data "in any form," so
   even a summary is arguably covered.

4. **Personal-only via Strava MCP.** David coaching himself, own data. Compliant,
   but it ends the friends product.

## Recommendation

Do not resubmit the capacity request as-is. Option 1 (written question to Strava)
first — it's cheap and it tells us whether Options 2–4 are even necessary. In
parallel, scope Option 2, since it's the only path that preserves both the
multi-athlete product and the AI coach if Strava says no.

This is a spec-level finding: the "Strava required / Agent SDK reads a pre-fetched
Strava folder" locks in CLAUDE.md §4 and SPEC.md are now in tension with Strava's
terms. Flagging rather than editing the spec unilaterally.
