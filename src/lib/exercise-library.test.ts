import { describe, it, expect } from 'vitest';
import { loadExerciseLibrary, resolveExercise, normalizeExerciseName } from './exercise-library';

describe('exercise-library', () => {
  it('parses all 24 corpus entries with id, name, and source', () => {
    const all = loadExerciseLibrary();
    expect(all.length).toBe(24);
    for (const ex of all) {
      expect(ex.id).toMatch(/^[a-z0-9-]+$/);
      expect(ex.name.length).toBeGreaterThan(0);
      expect(ex.source).toMatch(/^https?:\/\//);
    }
  });

  it('resolves by slug', () => {
    const ex = resolveExercise({ slug: 'single-leg-calf-raise' });
    expect(ex?.id).toBe('single-leg-calf-raise');
    expect(ex?.source).toBe('https://www.youtube.com/watch?v=2fiF2Ku8Y_U');
  });

  it('falls back to normalized name when no slug', () => {
    const ex = resolveExercise({ name: 'Dead Bug' });
    expect(ex?.id).toBe('dead-bug');
    expect(ex?.source).toBe('https://www.youtube.com/watch?v=BZYaCzbP09M');
  });

  it('prefers an exact slug over the name', () => {
    const ex = resolveExercise({ slug: 'front-plank', name: 'whatever' });
    expect(ex?.id).toBe('front-plank');
  });

  it('returns undefined for an unmatched reference', () => {
    expect(resolveExercise({ slug: 'does-not-exist' })).toBeUndefined();
    expect(resolveExercise({ name: 'Push-ups' })).toBeUndefined();
    expect(resolveExercise({})).toBeUndefined();
  });

  it('normalizes names to kebab-case', () => {
    expect(normalizeExerciseName('Dead Bug')).toBe('dead-bug');
    expect(normalizeExerciseName('Single-leg calf raises')).toBe('single-leg-calf-raises');
  });
});
