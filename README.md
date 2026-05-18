# hammytime

Hammytime is a multi-tenant Telegram-based marathon coaching bot built for a small, friends-only group of athletes. The full product spec — architecture decisions, scope locks, database schema, and agent loop design — lives in [Specs/SPEC.md](Specs/SPEC.md). This is the Next.js 15 web app that handles allowlist signup, Strava OAuth handoff, a read-only plan view, and a David-only admin console; the coaching product itself is delivered entirely through Telegram.
