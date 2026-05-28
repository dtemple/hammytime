# Conversational Coach — Architecture Refactor + Feature Expansion

**Author:** dtemple
**Date:** 2026-05-29
**Status:** draft v0.1
**Supersedes:** ad-hoc reply work proposed mid-build (Prompt 20 series in `claude_code_prompts.md`).
**Related:** `Specs/SPEC.md` is the primary spec; this document is a focused expansion covering one body of work.

---

## 1. Purpose

This document describes the architectural refactor that takes hammytime's daily coaching loop from a hand-rolled single-Claude-call agent runtime to the Claude Agent SDK pattern — and the feature expansion enabled by that refactor (conversational ad-hoc replies, memory writes during chat, calendar mutability, tool-based proposal/confirmation, mandatory activity awareness, typing indicator, lead-with-coaching morning check-in).

Reading order: this spec, then `Specs/SPEC.md` for product-level context if needed.

## 2. Why this refactor now

We've accumulated complexity working around a constraint that doesn't need to exist.

The v0.6.1 simplification said "single Claude call, no tool loop" because we were uncertain the daily loop would work and wanted to ship fast. That made sense at the time. But every subsequent feature request — memory writes during ad-hoc, calendar mutability, tool calls, proactive suggestions — needed custom additions on top of the single-shot runtime. The proposed 7-prompt expansion (in `claude_code_prompts.md`) was rebuilding what the Claude Agent SDK already provides, piece by piece.

The clarifying observation: David has been "dogfooding" the same agent pattern for months via Claude Code in the personal coach repo (`~/projects/health-agent`). That setup works well because Claude Code IS an agent runtime — it reads files when it decides to, writes when it decides to, looks things up when it decides to. Hammytime's hand-rolled equivalent is doing the same job with more code and less flexibility.

The simpler architecture: use the Claude Agent SDK. Expose hammytime's primitives (memory file ops, Strava fetches, calendar overrides, Telegram send) as tools. Pass a parameterized version of the personal coach's CLAUDE.md as the system prompt. Let the agent decide.

This refactor isn't optional — without it, the next ~7 prompts of feature work would each rebuild a slice of what the SDK provides. With it, those features collapse into 3 focused prompts.

## 3. New architecture

```
                   ┌──────────────────────────────────┐
                   │ Effective Plan View              │
                   │   = active plan_version          │
                   │   + active day_overrides         │
                   │   + Strava activities today      │ ← always-included context
                   └──────────────┬───────────────────┘
                                  │
                  reads via       │
                  context load    │
                                  ▼
   ┌───────────────────────────────────────────────────┐
   │       Claude Agent SDK Session                    │
   │                                                   │
   │  System prompt: parameterized CLAUDE.md           │
   │  Tools:                                           │
   │    - read_memory_file, write_memory_file,         │
   │      append_to_memory_file                        │
   │    - fetch_strava_activities                      │
   │    - propose_day_override                         │
   │    - propose_memory_update                        │
   │    - web_search (later)                           │
   │  User message: athlete's incoming text +          │
   │                pre-loaded athlete context         │
   │                                                   │
   │  Multi-turn until agent stops (typically 1-5      │
   │  turns; bounded by max_turns config).             │
   └──────────────┬────────────────────────────────────┘
                  │
                  ▼
        Final assistant message → Telegram
        Side effects: memory file writes, override
        proposals (pending athlete confirmation)
```

Two trigger sources, one agent loop:

- **Morning cron (daily check-in)** — server fires the agent at athlete-local 6:30 AM with a "morning coaching read" framing in the user message. Agent generates and sends. **Wellness battery does NOT auto-fire.** Athlete invokes `/checkin` when they want to log wellness.
- **Athlete-initiated message (ad-hoc)** — webhook fires, server starts an agent session with the message text + context, agent responds.

Slash commands (`/checkin`, `/calendar`, `/connect_strava`, etc.) stay as explicit shortcuts. Everything else routes to the agent.

## 4. Behavioral requirements

### 4.1 Lead with coaching, not wellness questions

The morning check-in cron currently fires the wellness battery first, then the agent. Reverse this: morning cron fires the agent directly with the athlete's full context. The agent generates a coaching read for the day. Sent to Telegram.

If the athlete wants to log wellness data (readiness, soreness, note), they type `/checkin`. The structured battery runs (readiness → soreness → optional note → log to wellness_log.md). Agent does NOT auto-run after `/checkin` completes; it'd be redundant with the morning coaching that already happened. Athlete can ask the agent any follow-up questions in chat — those route through the standard agent loop.

Rationale: the wellness battery is administrative; the coaching read is the product. Leading with the product matches what the athlete actually wants from the morning interaction.

### 4.2 Mandatory activity awareness

The single most painful failure mode in the personal coach: the agent doesn't know if the athlete already ran today, so it tells them to go out and run. This undermines confidence. Critical to fix.

Two-layer fix:

**Layer 1: always-included Strava activity context.**

Before every agent invocation, server fetches today's logged Strava activities for the athlete. Includes them explicitly in the user message under a dedicated section:

```
## Today's training so far (athlete-local date YYYY-MM-DD)

<if activities exist>:
- <type> · <distance_mi> mi · <duration_min> min · started <HH:MM local>
- <athlete title/notes if any>
<if no activities>:
Nothing logged on Strava today yet.
```

This section is built deterministically by the server; the agent doesn't decide whether to include it. Agent reads it as authoritative truth about what's already happened.

The system prompt explicitly instructs:

> Before recommending anything for today, check the "Today's training so far" section. If activities are logged, the athlete already trained — frame your response around what happened, not what to do. If you tell an athlete to go out and run when they already did, you've broken trust.

**Layer 2: inline-button override for Strava lag.**

Strava sync isn't instant. An athlete might finish a run at 7am, see the agent's morning message at 7:30am that still doesn't reflect the activity, and want to correct.

Every agent response sent in a context where "today's training so far" was relevant (morning checkin, anytime in the first half of the day) includes two inline-keyboard buttons at the bottom:

- ✅ **Already done** — athlete taps if they trained but it's not reflected yet
- 👍 **Got it** — athlete taps to dismiss (or just doesn't tap)

If athlete taps "Already done," the server: (a) re-fetches Strava once (in case it synced), (b) if still not there, records a `manual_completion_marker` in the day's overrides ("athlete reports today's training is complete"), (c) re-runs the agent with this new context, (d) sends the updated response.

The system prompt instructs the agent to honor the manual_completion_marker the same way it honors a Strava activity.

### 4.3 Typing indicator during agent processing

Agent runs can take 10-30 seconds with multi-turn tool calling. Silent waits feel broken. Fix: Telegram typing action while the agent thinks.

Implementation: wrap each agent invocation in a helper that:
1. Fires `bot.api.sendChatAction(chatId, 'typing')` immediately on entry.
2. Sets an interval to refresh the typing action every 4 seconds (Telegram's typing action expires after ~5s).
3. Stops the interval when the agent's final response is sent (or on error).

Telegram's typing action is free (just an API call). The implementation is ~20 lines of helper code.

### 4.4 Memory writes during conversation

Agent has tools for memory file operations. When it decides to write — based on the patterns in the personal coach's CLAUDE.md (memory write-through rule, body sensations in chat, durable facts mentioned anywhere) — it calls the tool. Write happens server-side via the existing memory helpers.

Two write modes:

- **Direct writes** (no confirmation): updates to `checkin_log.md` (append a daily entry), updates to `open_questions.md` (resolve a question, add a new one), routine bookkeeping. Agent decides; happens immediately.
- **Confirmed writes** (with inline-keyboard): changes that materially affect the athlete's view of their state — new injuries in `injury_log.md`, edits to `athlete_profile.md` injury history, race calendar additions. Agent emits a `propose_memory_update` tool call; server renders the proposal with confirm/modify/cancel buttons; athlete taps; server applies.

The line between direct and confirmed writes: if a friend reviewing the system thought "wait, why is that there?" the write needed confirmation. If it's obviously routine bookkeeping the agent is doing on their behalf, direct is fine. Concrete:

- `append_to_memory_file('checkin_log.md', entry)` — direct.
- `add_open_question(text)` — direct.
- `mark_open_question_resolved(id, resolution)` — direct.
- `add_injury(body_part, severity, status, notes)` — confirmed.
- `update_athlete_profile_section(section, content)` — confirmed.
- `update_injury_log_entry(injury_id, changes)` — confirmed.
- `update_race_calendar(action, race_data)` — confirmed.

### 4.5 Calendar mutability via day overrides

Plan versions stay immutable per `Specs/SPEC.md` §3.4.4. Short-term day-level changes — move a long run, swap days, drop a strength session — happen via a separate `plan_day_overrides` table. The "effective plan view" (what the agent reads, what the calendar renders, what the daily checkin uses) is `active plan_version.plan_json + active overrides`.

Override types:

- `move` — workout originally on date X moves to date Y. Original date becomes rest (or another override).
- `swap` — two days exchange workouts.
- `replace` — keep the date, change what's on it (different workout type or details).
- `cancel` — workout on date X is cancelled (rest day).
- `modify` — same workout, adjust distance / duration / intensity / notes.
- `add` — add a workout on a date that was a rest day.
- `manual_completion_marker` — special override type used by the "Already done" button (§4.2 layer 2). Doesn't change planned workout, just notes "athlete confirms this day's training is complete despite Strava not reflecting it."

Schema:

```sql
create table plan_day_overrides (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references athletes(id) on delete cascade,
  plan_version_id uuid not null references plan_versions(id),
  override_type text not null check (override_type in
    ('move', 'swap', 'replace', 'cancel', 'modify', 'add', 'manual_completion_marker')),
  target_date date not null,
  payload jsonb not null,
  reason text,
  proposed_by text check (proposed_by in ('agent', 'athlete', 'manual')) not null,
  confirmed_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);

create index on plan_day_overrides(athlete_id, target_date)
  where superseded_at is null;
create index on plan_day_overrides(athlete_id, plan_version_id)
  where superseded_at is null;
```

When a new plan_version becomes active (via plan regeneration, post-launch), all overrides on the prior plan_version are bulk-set `superseded_at = now()`. Not migrated to the new version — fresh start.

Override write flow:

1. Agent emits `propose_day_override` tool call with structured payload.
2. Server renders proposal to athlete as inline-keyboard message: "Proposed change: <human-readable description>. ✅ Confirm / ✏️ Modify / ❌ Cancel"
3. Athlete taps Confirm → server inserts row with `confirmed_at = now()`, `proposed_by = 'agent'`.
4. Calendar feed refreshes on its own cycle (Apple ~1 hour, Google ~daily); next read shows the updated effective view.
5. Athlete taps Modify → agent runs again with the "athlete wants to modify <proposal>" context; iterates.
6. Athlete taps Cancel → proposal dies; no override created.

Examples of override proposals the agent might generate:

- Monday is Memorial Day. Athlete mentions traveling. Agent proposes: move long run to Tuesday; drop Thursday strength to compensate.
- Athlete reports back-to-back travel weeks. Agent proposes: cancel Tuesday tempo, replace with Wednesday easy run; modify Saturday long run to be shorter.
- Athlete says "feet are wrecked today." Agent proposes: replace today's planned hills with easy 5mi on flat road.

### 4.6 Inline-keyboard confirmation framework

Generalized callback-query handling for any agent-proposed action. The same framework serves:

- Memory write confirmations (§4.4)
- Day override confirmations (§4.5)
- Activity-completion overrides (§4.2 layer 2)
- Future: plan regeneration confirmations, race calendar edits, etc.

Token structure for callback data:

```
"<action>:<proposal_id>:<choice>"
e.g., "confirm:abc123:yes" or "override:xyz789:modify"
```

`proposal_id` is a short ID (8-12 chars) generated server-side when the proposal is created and stored in a `pending_proposals` table with TTL (24h default). Telegram callback_data has a 64-byte limit, so we encode references rather than full payloads.

Server-side `pending_proposals` table:

```sql
create table pending_proposals (
  id text primary key,  -- short ID
  athlete_id uuid not null references athletes(id) on delete cascade,
  proposal_type text not null,  -- 'override', 'memory_update', 'activity_completion'
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  resolved_at timestamptz,
  resolution text  -- 'confirmed', 'modified', 'cancelled', 'expired'
);
```

When an athlete taps a button on a proposal older than 24h, server replies: "This proposal expired. Want to bring it up again?" — and lets the agent regenerate.

### 4.7 Tool catalog (v1 minimum)

Tools the agent has access to in v1 of the refactored runtime:

**Reading:**
- `read_memory_file(filename)` — returns content_md of the named file for current athlete.
- `list_memory_files()` — returns names of files that exist for the athlete.
- `fetch_strava_activities(start_date, end_date)` — returns list of activities in date range.
- `get_current_plan()` — returns the effective plan view (base + overrides).

**Writing (direct, no confirmation):**
- `append_to_memory_file(filename, entry)` — append a block to a log-shaped file.
- `update_memory_file_section(filename, section_name, content)` — replace a `## Section` block.
- `add_open_question(text)` — adds to open_questions.md table.
- `mark_open_question_resolved(id, resolution)` — closes an open question.

**Proposing (requires athlete confirmation via inline keyboard):**
- `propose_day_override(override_type, target_date, payload, reason)` — creates pending proposal.
- `propose_memory_update(filename, action, payload, reason)` — for confirmed-write memory operations.

**External (later, post v1):**
- `web_search(query)` — wrap WebSearch tool.
- `web_fetch(url)` — wrap WebFetch.
- `lookup_race(name)` — wrap existing race-lookup helper.

The tool catalog is intentionally small in v1. Add tools when there's a concrete reason — not preemptively.

### 4.8 What does NOT change

To bound the refactor:

- **Onboarding flow** stays as-is. Conversational coach exists post-onboarding. Onboarding state machine, slash commands, and the wellness battery itself (when triggered) are independent code paths.
- **Strava OAuth and webhook scaffolding** stays as-is. The agent uses existing Strava client helpers via tools.
- **Calendar feed (`/api/calendar/[token].ics`)** stays — but reads the effective plan view (base + overrides) instead of just plan_json directly. Small change inside the calendar generator; same endpoint.
- **The `/checkin` slash command** stays as the explicit wellness-capture trigger. Just no longer auto-fires on morning cron.
- **All existing memory file helpers** (`upsertMemorySection`, `upsertProfileSection`) stay — they become the implementation of the agent's memory-write tools.
- **Existing system prompts** are reused as the basis for the SDK's system prompt (parameterized for athlete context).

## 5. Tools catalog detail

Each tool definition specifies: name, parameters (with JSON schema), return type, whether it requires confirmation, behavioral notes for the agent.

`<expand each tool from §4.7 with parameter schemas, return types, and example invocations. Drafted in implementation PR; not blocking spec approval.>`

## 6. The "did I already run" deep-dive

Reiterating because this is the most important behavioral fix. The structure:

1. Server-side pre-load (every agent invocation, no exceptions): fetches today's Strava activities for the athlete; assembles "## Today's training so far" block; includes in user message.

2. System prompt has a dedicated paragraph telling the agent to read this section FIRST, before generating any prescriptive content. If the section shows activities, the agent's response frames around what happened.

3. End of every potentially-prescriptive response (morning cron, ad-hoc replies during the first half of the day), inline keyboard with "Already done" / "Got it" buttons. Tap "Already done" → server fetches Strava once more, then if still nothing, records `manual_completion_marker` override, then re-runs the agent.

4. Tests for this should be explicit — feed the agent a context with activities logged + a prompt that would naively lead to "go run", verify the response correctly references the completed activity.

This is the single failure mode worth designing aggressively against because it's the one that erodes trust fastest. Athletes who don't trust the coach stop using the coach.

## 7. Typing indicator pattern

Helper at `src/server/telegram/typing.ts`:

```ts
export async function withTyping<T>(
  chatId: number,
  fn: () => Promise<T>
): Promise<T> {
  const bot = telegramBot();
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await bot.api.sendChatAction(chatId, 'typing');
    } catch (e) {
      // typing action failure is non-fatal
    }
  };

  tick(); // immediate first send
  const interval = setInterval(tick, 4000);

  try {
    return await fn();
  } finally {
    stopped = true;
    clearInterval(interval);
  }
}
```

Wrap every agent invocation: `await withTyping(chat_id, () => runAgent(...))`. Telegram's typing action implicitly stops when the next bot message is sent (or after ~5s if no message arrives), so no explicit cleanup beyond clearing the interval.

## 8. Sequencing — 3 prompts

The refactor + new features sequenced as three Claude Code sessions:

### Prompt M1 — Agent SDK migration + lead-with-coaching + activity awareness + typing indicator

Replaces the current `src/server/agent/daily-checkin.ts` and the ad-hoc handler placeholder with a unified Agent SDK runtime.

Includes:
- Install Anthropic Agent SDK (or whichever package name the SDK ships as currently).
- New `src/server/agent/agent-runtime.ts` exporting `runAgent(athleteId, opts)` where opts include the trigger source (`'cron'` | `'ad_hoc'` | `'manual_completion'`) and the inbound message text (if applicable).
- Tools (subset of §4.7 — read tools, direct-write memory tools, fetch_strava_activities). Proposal tools deferred to M2. Web search deferred to later.
- System prompt at `src/server/agent/prompts/coach.system.md` — extracted from `~/projects/health-agent/CLAUDE.md` with templating for athlete name, plan context, etc.
- "Today's training so far" pre-load block in user message (mandatory, always present).
- Typing-indicator wrapper.
- Morning cron updated: skip the wellness battery, call `runAgent(athleteId, {source: 'cron'})` directly.
- `/checkin` command unchanged in its wellness-capture role; just stops triggering agent after.
- Ad-hoc inbound message routing in `bot.ts` calls `runAgent(athleteId, {source: 'ad_hoc', message: text})`.
- Tests + manual verification including the "athlete already ran today" scenario.

This is the foundational prompt. Larger than the others — probably 2-3 hours of Claude Code work — but it replaces ~5 prompts' worth of work that the old architecture would have required.

### Prompt M2 — Day overrides + proposal/confirmation framework

Includes:
- `plan_day_overrides` migration (schema from §4.5).
- `pending_proposals` migration.
- Effective plan view computation function — reads active plan_version + active overrides, returns rendered effective plan.
- Calendar feed updated to render the effective view.
- Daily-checkin user message updated to read effective view.
- `propose_day_override` and `propose_memory_update` tools added to agent's catalog.
- Inline-keyboard callback handler generalized to handle proposal confirmations.
- Activity-completion "Already done" button (§4.2 layer 2) implemented; uses the same proposal framework.
- Tests + manual verification.

This unlocks calendar mutability and confirmation-gated memory writes.

### Prompt M3 — Polish and follow-ups

Includes:
- Web-search and lookup_race tools (only if there's a concrete use case observed during dogfooding).
- Per-athlete token usage view + admin surface.
- Proactive suggestion pattern: agent prompted to look ahead at the next 7 days, surface relevant adjustments. Could be folded into the morning cron's user message ("today is <date>; here are upcoming dates with relevant context: <holidays, weather, race countdown>") rather than a separate code path.
- Any UX adjustments surfaced during dogfooding of M1 + M2.

Optional — may not need a full prompt if M1 and M2 cover what David actually wants.

## 9. Migration map — what survives, what gets replaced

| Existing | Status under refactor |
|---|---|
| `daily-checkin.ts` (agent runtime) | **Replaced** by `agent-runtime.ts` |
| `ad-hoc.ts` (planned but not built) | **Not needed** — same code path as daily checkin |
| Wellness battery state machine in `wellness.ts` | **Kept**, runs on `/checkin` only |
| Memory file helpers (`upsertMemorySection`, etc.) | **Kept**, become implementation of agent's memory tools |
| Strava client (`activities.ts`, `client.ts`) | **Kept**, exposed as tools |
| `/api/calendar/[token].ics` endpoint | **Kept**, reads effective plan view |
| `link_tokens`, `oauth_tokens`, `messages` tables | **Kept** |
| `plan_versions` table | **Kept**, becomes "base plan" for the effective view |
| `agent_runs` + `agent_run_steps` tables | **Kept**, Agent SDK persists into these |
| Onboarding state machine + steps 0-8 | **Kept entirely** |
| Cron endpoint | **Kept**, but calls `runAgent` instead of starting wellness battery |
| Slash commands (`/connect_strava`, `/calendar`, `/restart`, etc.) | **Kept** |
| Sentry, observability, env wiring | **Kept** |

Nothing gets thrown away. Most existing code is reused via tools. The replacements are concentrated in the agent runtime itself.

## 10. Tradeoffs

**Token cost.** Multi-turn agent calls use more tokens than single-shot. Typical morning check-in might do 2-4 turns (read injury_log, read recent checkins, write today's checkin entry, generate response). Roughly 3x the cost of single-shot ($0.06-0.15 vs $0.02-0.05). At one user, negligible. At 25 users, ~$100-200/month vs the original ~$80-110 estimate — still within `Specs/SPEC.md` §2.1 budget.

**Latency.** Multi-turn = slower responses. 10-30 seconds typical vs 5-10 today. Mitigated by the typing indicator. Athletes don't expect instant coach replies; thoughtful pauses feel right.

**Less explicit behavior control.** Agent decides what to do. Could it do something unexpected? Within the tool catalog, the worst case is "writes a memory file update that's slightly off" — which can be reverted manually. Mitigated by: scoped tool catalog (agent can only do what tools allow), confirmation gating on material changes, comprehensive logging via `agent_runs`.

**Reliance on SDK maturity.** The Claude Agent SDK is mature but newer than the underlying API. If the SDK has a bug, we're affected. Mitigated by: pinned SDK version, comprehensive Sentry capture, graceful error handling at the agent runtime boundary.

**Cold-start latency.** Loading athlete context (memory files, recent activities, plan) before each agent invocation is ~200-500ms. Negligible compared to agent execution time.

## 11. Open questions / future considerations

- **When does an override "graduate" to a new plan version?** Currently never — overrides accumulate. If athlete has 20 active overrides on a 22-week plan, the effective view has drifted substantially from the base plan_version. Worth thinking about a "your plan has drifted enough that a regeneration would be cleaner" signal. Defer.
- **Voice notes from Telegram.** Whisper transcription, then route to agent as text. Defer until conversational coach is solid.
- **Group features / multiple athletes sharing context.** Out of scope for v1 entirely; noted for v2.
- **Plan regeneration.** Still the post-launch step before friends. The agent's tool catalog will eventually include `propose_plan_regeneration` once that flow exists.
- **Conversation summarization for very long histories.** Last 10 messages plus full memory files is the v1 context. Long conversations may eventually need summarization. Defer; cheap to add when needed.
- **Cost cap per athlete.** Track usage; consider alerting at thresholds. Defer to M3 if useful.
- **Manual override command.** `/edit_today` or similar for athletes to directly edit a day without agent involvement. Defer; agent-proposed flow handles 90% of cases.

## 12. Implementation notes

- **Anthropic Agent SDK package name and API surface should be verified during M1 planning.** Claude Code can check the current package and its docs.
- **System prompt extraction from CLAUDE.md.** The personal coach's CLAUDE.md is ~250 lines. Most translates directly to hammytime; a few sections (e.g. "Look it up before asking" tool list, marathon plan path references) need adaptation. The extracted prompt at `coach.system.md` should be reviewable as a standalone artifact — if reading it doesn't feel like reading a coaching brief, the extraction missed something.
- **Per-athlete templating.** The system prompt has placeholders for athlete name, goal race, key injury history. Filled at runtime from the athlete row + memory files. Athletes never see this — only the agent does.
- **Memory file format consistency.** Agent writes via tools that take structured input (`append_to_memory_file(filename, entry)`), not raw file content. Tools preserve format. Memory files stay parseable.
- **Failure handling.** Agent SDK errors (timeout, API failure, tool error) bubble up to the runtime entry point. On error: log to Sentry, send athlete a soft fallback ("Hit a snag — try again? If it keeps happening, ping David."), persist the failed `agent_runs` row with error string.

## 13. Out of scope (explicitly)

To prevent scope creep during implementation:

- Implementing the plan-gen feature (regeneration) — still the final pre-launch step.
- Implementing the ICS feed beyond reading the effective plan view (the feed itself is shipped, just needs the effective-view update).
- Building the proactive suggestion logic as a separate code path (folded into morning cron's user message instead).
- Multi-athlete fan-out for the cron (deferred per `SPEC.md` v0.6.2).
- Refactoring the wellness battery beyond decoupling it from cron.
- Onboarding changes of any kind.
- Strava webhook integration (still post-launch).
- Test coverage for code paths not affected by this refactor.

## 14. References

- `Specs/SPEC.md` — primary product/architecture spec.
- `~/projects/health-agent/CLAUDE.md` — personal coach pattern this refactor mirrors.
- `~/projects/health-agent/friends release spec.md` — running spec with full architectural history.
- `claude_code_prompts.md` — prompt history; the proposed 7-prompt expansion in the "post-Prompt 19" section is superseded by this refactor.
