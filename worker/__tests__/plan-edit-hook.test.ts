import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { makePlanEditHook } from '../plan-edit-hook';

const seedPath = path.join(__dirname, '../../seeds/marathon_training_plan.json');
const seedJson = readFileSync(seedPath, 'utf8');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'peh-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function postToolUse(filePath: string) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: filePath },
    tool_response: {},
    tool_use_id: 'tu-1',
    session_id: 's-1',
    transcript_path: '/dev/null',
    cwd: dir,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function runHook(filePath: string) {
  const hooks = makePlanEditHook(dir);
  const matcher = hooks.PostToolUse?.[0];
  expect(matcher?.matcher).toBe('Write|Edit');
  const cb = matcher!.hooks[0]!;
  return cb(postToolUse(filePath), 'tu-1', { signal: new AbortController().signal });
}

describe('makePlanEditHook', () => {
  it('ignores edits to files other than the plan', async () => {
    writeFileSync(path.join(dir, 'checkin_log.md'), 'not json at all');
    const out = await runHook(path.join(dir, 'checkin_log.md'));
    expect(out).toEqual({});
  });

  it('blocks when the edited plan is not valid JSON', async () => {
    writeFileSync(path.join(dir, 'marathon_training_plan.json'), '{broken');
    const out = await runHook(path.join(dir, 'marathon_training_plan.json'));
    expect(out).toMatchObject({ decision: 'block' });
    expect((out as { reason?: string }).reason).toMatch(/doesn't parse as JSON/);
  });

  it('blocks a schema-invalid plan, listing the issues', async () => {
    writeFileSync(path.join(dir, 'marathon_training_plan.json'), '{"weeks":[]}');
    const out = await runHook(path.join(dir, 'marathon_training_plan.json'));
    expect(out).toMatchObject({ decision: 'block' });
    const reason = (out as { reason?: string }).reason ?? '';
    expect(reason).toMatch(/doesn't match the plan schema/);
    expect(reason).toMatch(/weeks|metadata/); // names the failing paths
  });

  it('passes a valid plan through silently', async () => {
    writeFileSync(path.join(dir, 'marathon_training_plan.json'), seedJson);
    const out = await runHook(path.join(dir, 'marathon_training_plan.json'));
    expect(out).toEqual({});
  });

  it('matches the plan file by relative path too (tools resolve against cwd)', async () => {
    writeFileSync(path.join(dir, 'marathon_training_plan.json'), '{broken');
    const out = await runHook('marathon_training_plan.json');
    expect(out).toMatchObject({ decision: 'block' });
  });
});
