import { mergeConfig, defineConfig } from 'vitest/config';
import base from './vitest.config';

// The eval harness (V4-W6). Separate from `npm test`: it runs *.eval.ts files
// (invisible to the default *.test.ts glob), makes real Sonnet spend, is
// non-deterministic, and is slow — never in CI. Run with `npm run eval`.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['src/server/telegram/onboarding/engine/__evals__/**/*.eval.ts'],
      setupFiles: ['src/server/telegram/onboarding/engine/__evals__/setup.ts'],
      // Live model calls per fixture; give the file room and run serially so the
      // prompt cache (5-min TTL) stays warm and spend stays predictable.
      testTimeout: 1000 * 60 * 10,
      hookTimeout: 1000 * 60 * 30,
      fileParallelism: false,
    },
  }),
);
