// Lookup over the prehab/strength corpus at `worker/knowledge/exercises.md`.
//
// The corpus is the single source of truth for exercise links. This module is
// the only reader on the application side: the calendar route (`/api/calendar/
// [token]`, on Vercel) and the worker's outbound send (`worker/send.ts`, on
// Fly) both import it to turn an exercise reference into its canonical `source`
// URL. The corpus file is shared, not duplicated — the path is anchored on
// `process.cwd()`, which is the repo root in both runtimes (Vercel project root;
// Fly container `/app`, see Dockerfile WORKDIR + `npx tsx worker/index.ts`).
//
// On Vercel the file lives outside the route's traced module graph, so
// `next.config.ts` adds it via `outputFileTracingIncludes`. If the read ever
// fails the index is empty and every lookup misses — callers degrade to "no
// link", never throw. The corpus enriches; a missing entry is never an error.

import { readFileSync } from 'fs';
import path from 'path';

export type Exercise = {
  id: string;
  name: string;
  region: string;
  cues: string;
  source: string;
};

type Library = {
  all: Exercise[];
  bySlug: Map<string, Exercise>;
  byNormalizedName: Map<string, Exercise>;
};

// Lowercase and kebab-case for name-fallback matching: "Dead Bug" -> "dead-bug".
// Note this does NOT canonicalize plurals — "Single-leg calf raises" normalizes
// to "single-leg-calf-raises", which won't match the `single-leg-calf-raise`
// id. That mismatch is why template exercises carry an explicit `exercise_slug`;
// name-fallback only catches the names that happen to normalize cleanly.
export function normalizeExerciseName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const HEADING_RE = /^###\s+\d+\.\s+(.+?)\s*$/;
const FIELD_RE = /^-\s+(id|region|targets|cues|source):\s*(.+?)\s*$/;

function parse(markdown: string): Library {
  const all: Exercise[] = [];
  let current: Partial<Exercise> | null = null;

  const flush = () => {
    if (current?.id && current.name && current.source) {
      all.push({
        id: current.id,
        name: current.name,
        region: current.region ?? '',
        cues: current.cues ?? '',
        source: current.source,
      });
    }
    current = null;
  };

  for (const line of markdown.split('\n')) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      current = { name: heading[1] };
      continue;
    }
    if (!current) continue;
    const field = FIELD_RE.exec(line);
    if (field) {
      const [, key, value] = field;
      if (key === 'id') current.id = value;
      else if (key === 'region') current.region = value;
      else if (key === 'cues') current.cues = value;
      else if (key === 'source') current.source = value;
      // `targets` is parsed past but not retained — links need id/name/source.
    }
  }
  flush();

  const bySlug = new Map<string, Exercise>();
  const byNormalizedName = new Map<string, Exercise>();
  for (const ex of all) {
    bySlug.set(ex.id, ex);
    // First writer wins so an exact id-derived key isn't clobbered by a name.
    const idKey = normalizeExerciseName(ex.id);
    const nameKey = normalizeExerciseName(ex.name);
    if (!byNormalizedName.has(idKey)) byNormalizedName.set(idKey, ex);
    if (!byNormalizedName.has(nameKey)) byNormalizedName.set(nameKey, ex);
  }
  return { all, bySlug, byNormalizedName };
}

const EMPTY: Library = { all: [], bySlug: new Map(), byNormalizedName: new Map() };

let cached: Library | null = null;

function corpusPath(): string {
  return path.join(process.cwd(), 'worker', 'knowledge', 'exercises.md');
}

function library(): Library {
  if (cached) return cached;
  try {
    cached = parse(readFileSync(corpusPath(), 'utf8'));
  } catch {
    cached = EMPTY;
  }
  return cached;
}

/** All parsed corpus entries (memoized). */
export function loadExerciseLibrary(): Exercise[] {
  return library().all;
}

/**
 * Resolve an exercise reference to its corpus entry. Slug-first (the reliable
 * path, set explicitly on template exercises), then a normalized-name fallback
 * for plan exercises without a slug. Returns undefined when nothing matches —
 * the caller emits no link.
 */
export function resolveExercise(ref: { slug?: string; name?: string }): Exercise | undefined {
  const lib = library();
  if (ref.slug) {
    const bySlug = lib.bySlug.get(ref.slug);
    if (bySlug) return bySlug;
  }
  if (ref.name) {
    const byName = lib.byNormalizedName.get(normalizeExerciseName(ref.name));
    if (byName) return byName;
  }
  return undefined;
}
