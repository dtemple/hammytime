/**
 * import-memory-files.ts
 *
 * One-shot script: ports the personal coach's memory files from the local
 * filesystem into the corresponding `memory_files` rows for a given athlete.
 *
 * Usage:
 *   npm run memory:import -- --athlete-email <email>
 *   npm run memory:import -- --athlete-email <email> --source-dir ~/projects/health-agent
 *   npm run memory:import -- --athlete-email <email> --dry-run
 *
 * Run --dry-run first and read the output before committing to a real write.
 *
 * Three merge strategies (never silently overwrites real data):
 *   prepend       — checkin_log.md, wellness_log.md
 *                   Empty DB row → write source directly.
 *                   Existing DB row → source + divider comment + existing.
 *   append-section — athlete_profile.md, injury_log.md, race_calendar.md,
 *                    personal_records.md, open_questions.md
 *                   Empty DB row → write source directly.
 *                   Existing DB row → existing + "## Imported from personal coach" + source.
 *   replace       — weekly_survey_log.md (v1 doesn't use it; source has longitudinal value)
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { supabaseAdmin } from "../src/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Strategy = "prepend" | "append-section" | "replace";

interface FileConfig {
  fileName: string;
  strategy: Strategy;
}

// ---------------------------------------------------------------------------
// Strategy map (hardcoded — matches hammytime's 8 memory files)
// ---------------------------------------------------------------------------

const FILE_CONFIGS: FileConfig[] = [
  { fileName: "checkin_log.md",       strategy: "prepend" },
  { fileName: "wellness_log.md",      strategy: "prepend" },
  { fileName: "athlete_profile.md",   strategy: "append-section" },
  { fileName: "injury_log.md",        strategy: "append-section" },
  { fileName: "race_calendar.md",     strategy: "append-section" },
  { fileName: "personal_records.md",  strategy: "append-section" },
  { fileName: "open_questions.md",    strategy: "append-section" },
  { fileName: "weekly_survey_log.md", strategy: "replace" },
];

// ---------------------------------------------------------------------------
// Pure merge functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Prepend strategy for log-shaped files.
 * Empty/null existing → source as-is (no orphan divider).
 * Existing content → source + divider comment + existing.
 */
export function applyPrepend(
  source: string,
  existing: string | null,
  date: string
): string {
  if (!existing) return source;
  return (
    source +
    "\n\n" +
    `<!-- ↑ historical entries imported ${date} | new entries appended below ↓ -->` +
    "\n\n" +
    existing
  );
}

/**
 * Append-section strategy for state files with onboarding content.
 * Empty/null existing → source as-is (clean write; no dangling section header).
 * Existing content → existing + import section header + source.
 */
export function applyAppendSection(
  existing: string | null,
  source: string,
  date: string
): string {
  if (!existing) return source;
  return (
    existing +
    "\n\n" +
    `## Imported from personal coach (${date})` +
    "\n\n" +
    source
  );
}

/**
 * Replace strategy — returns source unchanged regardless of existing.
 */
export function applyReplace(source: string): string {
  return source;
}

// ---------------------------------------------------------------------------
// CLI arg parsing (exported for testing)
// ---------------------------------------------------------------------------

export function parseArgs(): {
  athleteEmail: string;
  sourceDir: string;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let athleteEmail = "";
  let sourceDir = join(homedir(), "projects", "health-agent");
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--athlete-email" && args[i + 1]) {
      athleteEmail = args[++i]!;
    } else if (args[i] === "--source-dir" && args[i + 1]) {
      const raw = args[++i]!;
      // Expand leading ~ to home directory
      sourceDir = raw.startsWith("~/")
        ? join(homedir(), raw.slice(2))
        : raw;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  if (!athleteEmail) {
    console.error(
      "Usage: tsx scripts/import-memory-files.ts --athlete-email <email> [--source-dir <path>] [--dry-run]"
    );
    process.exit(1);
  }

  return { athleteEmail, sourceDir, dryRun };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { athleteEmail, sourceDir, dryRun } = parseArgs();

  if (dryRun) {
    console.log("[dry-run] No writes will happen.\n");
  }

  const db = supabaseAdmin();

  // --- Athlete lookup (users → athletes, same two-step as import-plan.ts) ---
  const { data: user, error: userErr } = await db
    .from("users")
    .select("id")
    .eq("email", athleteEmail)
    .maybeSingle();

  if (userErr) {
    console.error("Error looking up user:", userErr.message);
    process.exit(1);
  }
  if (!user) {
    console.error(`No user found with email: ${athleteEmail}`);
    process.exit(1);
  }

  const { data: athlete, error: athleteErr } = await db
    .from("athletes")
    .select("id, name")
    .eq("user_id", user.id)
    .maybeSingle();

  if (athleteErr) {
    console.error("Error looking up athlete:", athleteErr.message);
    process.exit(1);
  }
  if (!athlete) {
    console.error(
      `No athlete found for user ${athleteEmail}. Has the athlete completed Telegram linking?`
    );
    process.exit(1);
  }

  console.log(`Athlete: ${athlete.name} (${athlete.id})`);
  console.log(`Source dir: ${sourceDir}\n`);

  const date = new Date().toISOString().slice(0, 10);
  let imported = 0;
  let skipped = 0;
  let totalBytesWritten = 0;

  // --- Process each file ---
  for (const { fileName, strategy } of FILE_CONFIGS) {
    const sourcePath = join(sourceDir, fileName);

    if (!existsSync(sourcePath)) {
      console.log(`  ${fileName}: skipped (not in source)`);
      skipped++;
      continue;
    }

    const sourceContent = readFileSync(sourcePath, "utf8");

    // Read existing DB content
    const { data, error: readErr } = await db
      .from("memory_files")
      .select("content_md")
      .eq("athlete_id", athlete.id)
      .eq("file_name", fileName)
      .maybeSingle();

    if (readErr) {
      console.error(`  ${fileName}: error reading from DB: ${readErr.message}`);
      process.exit(1);
    }

    // Treat null, undefined, and "" as empty
    const existing = data?.content_md || null;
    const sizeBefore = existing?.length ?? 0;

    // Apply strategy
    let newContent: string;
    if (strategy === "prepend") {
      newContent = applyPrepend(sourceContent, existing, date);
    } else if (strategy === "append-section") {
      newContent = applyAppendSection(existing, sourceContent, date);
    } else {
      newContent = applyReplace(sourceContent);
    }

    const sizeAfter = newContent.length;

    console.log(
      `  ${fileName}: ${strategy} | before=${sizeBefore}B | after=${sizeAfter}B` +
      (dryRun ? " | [would write]" : " | written")
    );

    if (dryRun) {
      const preview = newContent.slice(0, 300);
      console.log(`    Preview (first 300 chars):\n    ${preview.replace(/\n/g, "\n    ")}\n`);
    } else {
      const { error: upsertErr } = await db.from("memory_files").upsert(
        {
          athlete_id: athlete.id,
          file_name: fileName,
          content_md: newContent,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "athlete_id,file_name" }
      );

      if (upsertErr) {
        console.error(`  ${fileName}: upsert failed: ${upsertErr.message}`);
        process.exit(1);
      }
    }

    imported++;
    totalBytesWritten += sizeAfter;
  }

  console.log(
    `\n${dryRun ? "[dry-run] Would import" : "Imported"} ${imported} files; ` +
    `${skipped} files skipped; ` +
    `total bytes ${dryRun ? "to write" : "written"}: ${totalBytesWritten}.`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
