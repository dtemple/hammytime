/**
 * import-plan.ts
 *
 * Imports a marathon training plan JSON into the hammytime database for a
 * specific athlete. Intended for manual use (e.g., seeding athlete 1 with
 * David's real plan before the daily loop ships).
 *
 * Usage:
 *   npm run plan:import -- --athlete-email <email>
 *   npm run plan:import -- --athlete-email <email> --plan-path /path/to/plan.json
 *
 * Default plan path: seeds/marathon_training_plan.json
 *
 * Idempotent: aborts with a clear message if the athlete already has a plans
 * row. Run `npm run clear:plans <email>` first to reset.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "fs";
import { join } from "path";
import { supabaseAdmin } from "../src/lib/db";
import { PlanSchema } from "../src/lib/plan-schema";
import { sendAndLog } from "../src/server/telegram/bot";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { athleteEmail: string; planPath: string } {
  const args = process.argv.slice(2);
  let athleteEmail = "";
  let planPath = join(process.cwd(), "seeds/marathon_training_plan.json");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--athlete-email" && args[i + 1]) {
      athleteEmail = args[++i]!;
    } else if (args[i] === "--plan-path" && args[i + 1]) {
      planPath = args[++i]!;
    }
  }

  if (!athleteEmail) {
    console.error("Usage: tsx scripts/import-plan.ts --athlete-email <email> [--plan-path <path>]");
    process.exit(1);
  }

  return { athleteEmail, planPath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { athleteEmail, planPath } = parseArgs();
  const db = supabaseAdmin();

  // 1. Read plan JSON
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (err) {
    console.error(`Failed to read plan at ${planPath}:`, err);
    process.exit(1);
  }

  // 2. Athlete lookup: users.email → athletes.user_id
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
    .select("id, name, telegram_chat_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (athleteErr) {
    console.error("Error looking up athlete:", athleteErr.message);
    process.exit(1);
  }
  if (!athlete) {
    console.error(`No athlete found for user ${athleteEmail}. Has the athlete completed Telegram linking?`);
    process.exit(1);
  }

  console.log(`Athlete: ${athlete.name} (${athlete.id})`);

  // 3. Validate plan against canonical schema
  let plan: ReturnType<typeof PlanSchema.parse>;
  try {
    plan = PlanSchema.parse(rawJson);
  } catch (err) {
    console.error("Plan validation failed:", err);
    process.exit(1);
  }

  const { metadata } = plan;
  console.log(
    `Plan: ${metadata.plan_structure.total_weeks} weeks, ` +
    `goal: ${metadata.race.name} on ${metadata.race.date}`
  );

  // 4. Idempotency check
  const { data: existingPlan, error: existingErr } = await db
    .from("plans")
    .select("id")
    .eq("athlete_id", athlete.id)
    .maybeSingle();

  if (existingErr) {
    console.error("Error checking existing plans:", existingErr.message);
    process.exit(1);
  }
  if (existingPlan) {
    console.error(
      `Athlete already has a plan (id: ${existingPlan.id}). ` +
      `Run \`npm run clear:plans ${athleteEmail}\` first.`
    );
    process.exit(1);
  }

  // 5. Sequential inserts
  // a. Find or create goal race row
  const goalRace = metadata.race;
  let raceId: string;

  const { data: existingRace, error: raceSelectErr } = await db
    .from("races")
    .select("id")
    .eq("athlete_id", athlete.id)
    .eq("name", goalRace.name)
    .maybeSingle();

  if (raceSelectErr) {
    console.error("Error looking up race:", raceSelectErr.message);
    process.exit(1);
  }

  if (existingRace) {
    raceId = existingRace.id;
    console.log(`Found existing race row: ${raceId}`);
  } else {
    const { data: newRace, error: raceInsertErr } = await db
      .from("races")
      .insert({
        athlete_id: athlete.id,
        name: goalRace.name,
        date: goalRace.date,
        distance_mi: goalRace.distance_miles,
        elevation_ft: goalRace.elevation_gain_ft ?? 0,
        terrain: goalRace.type ?? "road",
        target_type: goalRace.goal ?? "finish",
        ...(goalRace.target_time_sec !== undefined
          ? { target_time_sec: goalRace.target_time_sec }
          : {}),
        status: "upcoming",
      })
      .select("id")
      .single();

    if (raceInsertErr || !newRace) {
      console.error("Error inserting race:", raceInsertErr?.message);
      process.exit(1);
    }
    raceId = newRace.id;
    console.log(`Created race row: ${raceId}`);
  }

  // b. Create plans row (without current_version_id — set after plan_versions insert)
  const { data: newPlan, error: planInsertErr } = await db
    .from("plans")
    .insert({
      athlete_id: athlete.id,
      goal_race_id: raceId,
      start_date: metadata.plan_structure.start_date,
      weeks: metadata.plan_structure.total_weeks,
    })
    .select("id")
    .single();

  if (planInsertErr || !newPlan) {
    console.error("Error inserting plan:", planInsertErr?.message);
    process.exit(1);
  }
  console.log(`Created plan row: ${newPlan.id}`);

  // c. Create plan_versions row
  const { data: newVersion, error: versionInsertErr } = await db
    .from("plan_versions")
    .insert({
      plan_id: newPlan.id,
      version: 1,
      plan_json: plan as unknown as Record<string, unknown>,
      schema_version: 1,
      generated_by: "manual",
      status: "active",
    })
    .select("id")
    .single();

  if (versionInsertErr || !newVersion) {
    console.error("Error inserting plan_version:", versionInsertErr?.message);
    process.exit(1);
  }
  console.log(`Created plan_versions row: ${newVersion.id} (status=active)`);

  // d. Update plans.current_version_id
  const { error: planUpdateErr } = await db
    .from("plans")
    .update({ current_version_id: newVersion.id })
    .eq("id", newPlan.id);

  if (planUpdateErr) {
    console.error("Error updating plans.current_version_id:", planUpdateErr.message);
    process.exit(1);
  }

  // 6. Telegram confirmation
  if (athlete.telegram_chat_id) {
    const peakVolume = Math.max(...plan.weeks.map((w) => w.planned_total_run_miles ?? 0));
    const confirmText =
      `Imported your plan — ${metadata.plan_structure.total_weeks} weeks, peak ${peakVolume} mi/wk, ` +
      `goal: ${goalRace.name} on ${goalRace.date}. Daily coaching ships next.`;

    try {
      await sendAndLog(athlete.id, athlete.telegram_chat_id, confirmText);
      console.log("Sent Telegram confirmation.");
    } catch (err) {
      // Non-fatal: plan is imported; Telegram send is best-effort.
      console.warn("Telegram confirmation failed (plan still imported):", err);
    }
  } else {
    console.warn("Athlete has no telegram_chat_id — skipping Telegram confirmation.");
  }

  console.log("\n✓ Import complete.");
  console.log(`  plans.id            = ${newPlan.id}`);
  console.log(`  plans.current_version_id = ${newVersion.id}`);
  console.log(`  plan_versions.id    = ${newVersion.id}`);
  console.log(`  races.id            = ${raceId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
