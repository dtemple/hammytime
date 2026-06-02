# Claude Code task — wire the exercise library into coaching, calendar, and chat

## Context

`worker/knowledge/exercises.md` is a new read-only corpus: 24 prehab + strength exercises, each
with a stable `id` slug, region, target, 2–3 form cues, and a verified `source` URL (E3 Rehab
articles + two curated YouTube videos). It exists so the coaching agent grounds its exercise advice
in vetted sources and hands athletes a working link instead of a hallucinated one.

Before writing code, read (source-of-truth order from `CLAUDE.md` §2): `Specs/SPEC.md` (relevant
sections), `CLAUDE.md`, and `claude-status.md`. This is a spec-touching feature — a grounding corpus
the agent reads each run. **David has approved updating the spec for this work**, so update
`Specs/SPEC.md` to make the exercise library the source of truth: document the corpus
(`worker/knowledge/exercises.md`), that the coach reads it as static read-only context each run, the
"never fabricate a link / suggestions not rehab" rules, and the calendar + chat linking behavior.
Add a dated change-log entry (next version bump) and reconcile any section that describes agent
context or memory files. Keep the rest of CLAUDE.md §2 in force — `Specs/SPEC.md` stays the priority
source.

## Goal

Make the 24-exercise library usable in three places, in priority order:

1. **Agent grounding** — the coach can read the corpus and cite it.
2. **Calendar** — strength-day `.ics` events link each exercise to its `source`.
3. **Chat** — exercise references in coaching messages are tappable links (with a strict no-spam rule).

## Hard constraints

- **The library enriches; it never constrains what the coach recommends.** The coach must keep
  recommending the best exercise for the athlete regardless of whether it's in `exercises.md`. When a
  recommended exercise IS in the library, enrich it with the cues + `source` link; when it isn't,
  recommend it normally with no link. Do not narrow the coach's exercise vocabulary to this list, and
  do not make calendar/chat linking depend on the exercise being in the library (unmatched → no link,
  recommendation stands).
- **Never fabricate a link.** The only exercise URLs allowed anywhere are the `source` values in
  `exercises.md`. If a prescribed exercise has no entry, send no link for it — never invent one.
- **Linking etiquette (from the corpus header):** link an exercise *name* the first time it's
  recommended in a conversation; never paste raw URLs; never repeat the same link every message.
  This is the literal requirement: *if inline links aren't feasible in a path, omit the URLs rather
  than dumping youtube.com/... into every message.*
- Keep schema/dispatcher changes **additive and backward-compatible** (the codebase leans on this —
  see the W-series notes in `claude-status.md`).
- Stay in scope: no `principles.md`, no dynamic-warmup drills, no new exercises. Don't refactor
  surrounding code beyond what these three integrations require.
- `npm run typecheck`, `npm run lint`, and `npm run test` must pass. Add tests for new logic.

## The matching problem (solve this first)

Plan strength sessions carry exercises by **name** (`StrengthSessionTemplate.exercises[].name` in
`src/lib/plan-templates/types.ts`, rendered by `renderExercise` in `src/lib/calendar-render.ts`).
The corpus keys on **`id` slug**. You need a reliable name → corpus lookup. Recommended approach:

- Add a small loader/lookup module (e.g. `src/lib/exercise-library.ts`) that parses
  `worker/knowledge/exercises.md` once into `{ id, name, region, cues, source }[]` plus a
  `bySlug` / normalized-name index. (The file is also consumed by the worker; keep the path shared
  or duplicated deliberately — call out whichever you choose.)
- Add an **optional** `exercise_slug?: string` to the strength-exercise entry in
  `src/lib/plan-schema.ts`, and set it in the template strength sessions
  (`src/lib/plan-templates/templates/*.ts`) so linking is explicit rather than fuzzy name-matching.
  Fall back to normalized-name matching only for entries without a slug.

Decide and document the lookup; don't leave it implicit.

## 1. Agent grounding

- Make `exercises.md` available to the coach agent at run time. The worker hydrates a per-athlete
  folder in `worker/folder.ts` and runs `query()` with `cwd` = that folder (built-in Read/Grep).
  Add the corpus as a **static read-only file** copied into the working dir during hydrate (it is
  NOT per-athlete `memory_files` data, and `syncBack` must never write it back — treat it like the
  input-only files already excluded).
- Update `worker/prompts/coach.md`: tell the coach the library exists, when to consult it (athlete
  reports a niggle/soreness, asks how to do a movement, or you're prescribing strength/mobility),
  and to follow the corpus's own "Rules for the agent" — including the linking etiquette and the
  "suggestions, not rehab; defer real injuries" rule that already lives in `coach.md`.
- Confirm the isolation guard (`worker/isolation.ts`) allows reading the corpus path inside `cwd`.

## 2. Calendar `.ics` links

- In `src/lib/calendar-render.ts`, `renderExercise` currently emits `- {name} — {sets}×{reps}`.
  Append the resolved `source` link per exercise. iCal `DESCRIPTION` is plain text, so include the
  bare URL on the exercise line (this is the one place a raw URL is correct — a calendar description
  isn't a chat message). Resolve via the lookup from the matching step; if no entry, emit the line
  unchanged (no link).
- Update `src/lib/calendar-render.test.ts` and the snapshot. Verify a strength-day event in the
  generated `.ics` contains the expected URLs (route: `src/app/api/calendar/[token]/route.ts`).

## 3. Chat links (the careful one)

- `worker/send.ts` currently calls `sendMessage` with **no `parse_mode`**, so nothing is clickable.
  Telegram supports inline links via `parse_mode`. Prefer **HTML** (`<a href="URL">name</a>`) —
  easier to escape safely than MarkdownV2.
- Have the coach emit exercise references as the exercise *name* linked to its `source`, per the
  etiquette rule (first mention only, no repeats, no raw URLs). Update `worker/prompts/coach.md`
  with the exact output convention you choose, and make `send.ts` send with the matching parse mode.
- **Escaping is the risk.** If you enable a parse mode, every outbound message must be correctly
  escaped or sends will fail. Two safe options — pick one and justify it:
  (a) HTML parse mode with the coach emitting only `<a>` tags and you escaping `&<>` elsewhere; or
  (b) keep messages plain text and post-process only a small, well-defined link syntax the coach
  emits (e.g. `[[slug]]`) into Telegram entities, so arbitrary agent prose can't break parsing.
- **Fallback rule (explicit):** if reliable inline linking can't be made safe in a path, the coach
  must send the exercise name with **no URL** rather than pasting the link. Raw YouTube/article URLs
  in every message are not acceptable.
- Don't break the existing `send.ts` behavior: 4096-char chunking, per-chunk `messages` persistence,
  and the typing indicator. Update the `run-agent` test mock if the `send` signature changes.

## Acceptance criteria

- [ ] Coach can read `exercises.md` in a run; `coach.md` documents when/how to use it; `syncBack`
      never persists it; isolation guard permits the read.
- [ ] Strength-day `.ics` events include each exercise's `source` URL; tests + snapshot updated.
- [ ] Coaching messages render exercise names as tappable links (first mention only, no repeats);
      OR, where linking isn't safe, names appear with no raw URL. No path pastes URLs every message.
- [ ] Name → corpus lookup is explicit (slug-based) and documented; unmatched exercises degrade
      gracefully (no link, no crash).
- [ ] No fabricated links anywhere; only `exercises.md` `source` values are used.
- [ ] typecheck + lint + tests green.
- [ ] `Specs/SPEC.md` updated to make the exercise library the source of truth (corpus, agent-read
      behavior, linking rules) with a dated change-log entry; `claude-status.md` updated at session end.

## Out of scope

`principles.md`, dynamic-warmup drills, adding/curating exercises, the day-to-day onboarding path,
and any change to how plans are generated. If linking surfaces a need for those, note it for David
rather than building it.
