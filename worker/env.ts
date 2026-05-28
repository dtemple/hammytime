// Side-effect module: load .env.local before anything reads process.env.
// Must be the FIRST import in index.ts — ESM hoists imports above inline
// statements, so config.ts would otherwise read env vars before dotenv runs.
// In the Fly container the env comes from `fly secrets`, so a missing
// .env.local is fine (dotenv silently no-ops).
import { config } from 'dotenv';

config({ path: '.env.local' });
