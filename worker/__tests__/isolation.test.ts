import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { makeIsolationGuard, isInside, scrubbedEnv, ALLOWED_TOOLS } from '../isolation';

// Launch-gate test (M1 plan §5, §11). One athlete's agent must never reach
// another's folder. Build two sibling folders, point the guard at A, and assert
// every escape into B (or anywhere outside A) is denied.

let root: string;
let dirA: string;
let dirB: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'iso-'));
  dirA = path.join(root, 'athlete-A');
  dirB = path.join(root, 'athlete-B');
  mkdirSync(dirA);
  mkdirSync(dirB);
  writeFileSync(path.join(dirA, 'state.md'), 'A state');
  writeFileSync(path.join(dirB, 'athlete_profile.md'), "B's secret");
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('isInside', () => {
  it('allows the folder root and a child', () => {
    expect(isInside(dirA, dirA)).toBe(true);
    expect(isInside(dirA, 'state.md')).toBe(true);
    expect(isInside(dirA, path.join(dirA, 'sub', 'new.md'))).toBe(true);
  });

  it('rejects relative traversal into a sibling', () => {
    expect(isInside(dirA, '../athlete-B/athlete_profile.md')).toBe(false);
  });

  it('rejects an absolute path outside the folder', () => {
    expect(isInside(dirA, path.join(dirB, 'athlete_profile.md'))).toBe(false);
    expect(isInside(dirA, '/etc/passwd')).toBe(false);
  });

  it('rejects a symlink that escapes the folder', () => {
    const link = path.join(dirA, 'escape');
    symlinkSync(dirB, link);
    expect(isInside(dirA, path.join('escape', 'athlete_profile.md'))).toBe(false);
  });
});

describe('makeIsolationGuard', () => {
  const guard = (dir: string) => makeIsolationGuard(dir);

  it('allows file tools inside the folder', async () => {
    const g = guard(dirA);
    await expect(g('Read', { file_path: path.join(dirA, 'state.md') }, {} as never)).resolves.toEqual(
      { behavior: 'allow', updatedInput: { file_path: path.join(dirA, 'state.md') } },
    );
  });

  it('denies Read targeting a sibling folder (traversal)', async () => {
    const g = guard(dirA);
    const r = await g('Read', { file_path: '../athlete-B/athlete_profile.md' }, {} as never);
    expect(r.behavior).toBe('deny');
  });

  it('denies Glob/Grep with an escaping pattern', async () => {
    const g = guard(dirA);
    expect((await g('Glob', { pattern: path.join(dirB, '*.md') }, {} as never)).behavior).toBe(
      'deny',
    );
    expect((await g('Grep', { path: dirB }, {} as never)).behavior).toBe('deny');
  });

  it('denies Bash outright', async () => {
    const g = guard(dirA);
    const r = await g('Bash', { command: 'cat ../athlete-B/athlete_profile.md' }, {} as never);
    expect(r.behavior).toBe('deny');
  });

  it('denies any non-allowlisted tool', async () => {
    const g = guard(dirA);
    expect((await g('WebFetch', { url: 'https://x' }, {} as never)).behavior).toBe('deny');
  });

  it('allows WebSearch', async () => {
    const g = guard(dirA);
    expect((await g('WebSearch', { query: 'marathon taper' }, {} as never)).behavior).toBe('allow');
  });
});

describe('ALLOWED_TOOLS', () => {
  it('does not include Bash', () => {
    expect(ALLOWED_TOOLS).not.toContain('Bash');
  });
});

describe('scrubbedEnv', () => {
  it('passes the Anthropic key but no Supabase or athlete secrets', () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-secret';
    process.env.TELEGRAM_BOT_TOKEN = 'bot-secret';
    process.env.STRAVA_CLIENT_SECRET = 'strava-secret';

    const env = scrubbedEnv();

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
    expect(env).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY');
    expect(env).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
    expect(env).not.toHaveProperty('STRAVA_CLIENT_SECRET');

    process.env = saved;
  });
});
