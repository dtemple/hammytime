# Archived specs and prompts

These documents are superseded. They describe the **pre-v0.7 architecture** — the
Claude Agent SDK running in a Vercel serverless function with a hand-written
custom-tool catalog (`read_memory_file`, `propose_day_override`, etc.). The v0.7
pivot replaced that with the Agent SDK's **built-in tools** running in a Fly.io
worker container over a per-athlete folder of files. See the v0.7 change-log entry
in `Specs/SPEC.md` for the why.

Kept for history and because the *feature intent* (day overrides, the
proposal/confirmation flow, the "Already done" button) is still on the roadmap —
but any future milestone prompt must be rewritten against the container model, the
way `Specs/M1_IMPLEMENTATION_PLAN.md` was.

| File | Was | Superseded by |
|---|---|---|
| `CONVERSATIONAL_COACH.md` | The architecture-refactor spec (custom tools, Vercel function) | `Specs/SPEC.md` §3.1/§3.7 (v0.7) |
| `M1.md` | M1 prompt — Agent SDK migration with custom tools | `Specs/M1_IMPLEMENTATION_PLAN.md` |
| `M1.5.md` | Seam-hardening between the old M1 and M2 | — (folded away; reassess at M2) |
| `M2.md` | M2 prompt — day overrides + proposal framework on the old runtime | rewrite against the container model when M2 starts |

Do not treat anything here as current. `Specs/SPEC.md` is the source of truth.
