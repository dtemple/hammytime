// Multi-tenant isolation — the launch gate (SPEC risk #15, M1 plan §5).
//
// One athlete's agent must never read another's folder. Three layers:
//   1. cwd scoping (ergonomics, set by run-agent) — not a security boundary.
//   2. canUseTool guard (this file) — denies any file-tool call resolving
//      outside the athlete's folder, and denies Bash + every non-allowlisted
//      tool outright.
//   3. scrubbedEnv (this file) — the agent subprocess gets only the secrets
//      it needs (Anthropic key, PATH/HOME). No Supabase creds, no athlete
//      tokens — so even a hypothetical Bash escape has nothing to steal.
//
// M1 deviation from the plan sketch: Strava data is pre-fetched into the
// folder by the worker, so the agent never needs Bash. Bash is therefore
// denied entirely rather than allowlisted to a fetch script — a strictly
// smaller attack surface. Widening Bash later is a deliberate, reviewed change.

import { realpathSync } from 'fs';
import path from 'path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

export const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch'] as const;

// File tools whose path arguments must resolve inside the athlete folder.
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep']);

// Tool-input fields that carry filesystem paths or path-shaped patterns.
const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'pattern'];

function deny(message: string): PermissionResult {
  console.warn(`[isolation] DENY ${message}`);
  return { behavior: 'deny', message };
}

/**
 * Returns true if `target`, resolved against `root`, stays inside `root`.
 * Handles relative paths, absolute escapes, and symlink escapes (by resolving
 * the longest existing prefix with realpath).
 */
export function isInside(root: string, target: string): boolean {
  const resolvedRoot = realpathExisting(path.resolve(root));
  const resolved = realpathExisting(path.resolve(root, target));
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

// realpath the path if it exists; otherwise realpath the nearest existing
// ancestor and re-append the missing tail. Lets us check not-yet-created
// files (Write) while still catching symlinked ancestors.
function realpathExisting(p: string): string {
  let current = p;
  const tail: string[] = [];
  // Walk up until we hit something that exists.
  while (true) {
    try {
      const real = realpathSync(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p; // reached root, nothing existed
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function collectPaths(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const field of PATH_FIELDS) {
    const v = input[field];
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  return out;
}

/**
 * Builds the canUseTool guard for a single athlete run. Closes over the
 * athlete's folder; every decision is relative to it.
 */
export function makeIsolationGuard(dir: string): CanUseTool {
  const root = path.resolve(dir);
  return async (toolName, input) => {
    if (toolName === 'WebSearch') {
      return { behavior: 'allow', updatedInput: input };
    }
    if (FILE_TOOLS.has(toolName)) {
      for (const target of collectPaths(input)) {
        if (!isInside(root, target)) {
          return deny(`${toolName} path escapes athlete folder: ${target}`);
        }
      }
      return { behavior: 'allow', updatedInput: input };
    }
    return deny(`tool not permitted in worker: ${toolName}`);
  };
}

/**
 * The environment handed to the agent subprocess. The SDK's `env` option
 * REPLACES the subprocess environment, so we build it explicitly — spreading
 * process.env would leak every secret the worker holds. Pass only what the
 * Claude binary needs to run and reach Anthropic.
 */
export function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK']) {
    const v = process.env[key];
    if (v) out[key] = v;
  }
  return out;
}
