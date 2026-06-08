// Worker runtime configuration. All knobs read from env with sane defaults so
// the container can run with zero config in dev and be tuned in production.

export const ATHLETE_ROOT = process.env.ATHLETE_ROOT ?? '/data/athletes';
export const COACH_MODEL = process.env.COACH_MODEL ?? 'claude-sonnet-4-6';
// 20, not 12: a multi-day plan rewrite is 6+ sequential Edits plus the reads
// around it, and 12 left no margin once the agent had read the folder — runs
// were dying on max_turns and shipping the fallback. MAX_BUDGET_USD ($1) is the
// real cost bound, so a higher turn ceiling can't run away.
export const MAX_TURNS = numEnv('WORKER_MAX_TURNS', 20);
// Bumped 0.5 -> 1.0: structural plan edits routinely land at $0.47-$0.56 and
// were getting killed mid-write. Stopgap until the budget/persistence rework.
export const MAX_BUDGET_USD = numEnv('WORKER_MAX_BUDGET_USD', 1);
export const POLL_INTERVAL_MS = numEnv('WORKER_POLL_INTERVAL_MS', 3000);
export const MAX_ATTEMPTS = numEnv('WORKER_MAX_ATTEMPTS', 5);
export const STALE_LOCK_MINUTES = numEnv('WORKER_STALE_LOCK_MINUTES', 15);
export const STRAVA_LOOKBACK_DAYS = numEnv('WORKER_STRAVA_LOOKBACK_DAYS', 14);

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
