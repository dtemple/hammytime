// Eval setup: load .env.local so the REAL Sonnet call has ANTHROPIC_API_KEY.
// vitest does not load .env.local on its own (unlike Next.js), so the eval config
// references this as a setupFile. Mirrors the scripts/ab-model-eval.ts pattern.

import { config } from 'dotenv';
import { existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  config({ path: '.env.local' });
} else {
  config();
}

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    'ANTHROPIC_API_KEY is not set — the onboarding eval makes real Sonnet calls. ' +
      'Put it in .env.local (the eval reads it the same way the scripts do).',
  );
}
