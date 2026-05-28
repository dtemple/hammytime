// Worker runtime configuration. All knobs read from env with sane defaults so
// the container can run with zero config in dev and be tuned in production.

export const ATHLETE_ROOT = process.env.ATHLETE_ROOT ?? '/data/athletes';
export const COACH_MODEL = process.env.COACH_MODEL ?? 'claude-sonnet-4-6';
export const MAX_TURNS = numEnv('WORKER_MAX_TURNS', 12);
export const MAX_BUDGET_USD = numEnv('WORKER_MAX_BUDGET_USD', 0.5);
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
