/**
 * clear-athlete-plans.ts
 *
 * Clears all plan_versions, plans, and outstanding plan_paste tokens for an athlete.
 *
 * Usage: tsx scripts/clear-athlete-plans.ts <athlete_email>
 *
 * Run once after v0.6 cleanup applies to reset test state; delete script after use.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../src/lib/db";

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: tsx scripts/clear-athlete-plans.ts <athlete_email>");
    process.exit(1);
  }

  const db = supabaseAdmin();

  // Look up athlete via users.email → athletes.user_id (athletes has no email column)
  const { data: user, error: userErr } = await db
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (userErr) {
    console.error("Error looking up user:", userErr.message);
    process.exit(1);
  }
  if (!user) {
    console.error(`No user found with email: ${email}`);
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
    console.error(`No athlete found for user ${email}. Has the athlete completed Telegram linking?`);
    process.exit(1);
  }

  console.log(`Found athlete: ${athlete.name} (${athlete.id})`);

  // Look up plan IDs for this athlete
  const { data: plans, error: plansErr } = await db
    .from("plans")
    .select("id")
    .eq("athlete_id", athlete.id);

  if (plansErr) {
    console.error("Error fetching plans:", plansErr.message);
    process.exit(1);
  }

  const planIds = (plans ?? []).map((p) => p.id);

  // Delete plan_versions for all athlete plans
  let deletedVersions = 0;
  if (planIds.length > 0) {
    const { error: versionsErr, count } = await db
      .from("plan_versions")
      .delete({ count: "exact" })
      .in("plan_id", planIds);

    if (versionsErr) {
      console.error("Error deleting plan_versions:", versionsErr.message);
      process.exit(1);
    }
    deletedVersions = count ?? 0;
  }

  // Delete plans
  const { error: deletePlansErr, count: deletedPlansCount } = await db
    .from("plans")
    .delete({ count: "exact" })
    .eq("athlete_id", athlete.id);

  if (deletePlansErr) {
    console.error("Error deleting plans:", deletePlansErr.message);
    process.exit(1);
  }

  // Mark any outstanding plan_paste tokens as used
  const { error: tokensErr, count: markedTokensCount } = await db
    .from("link_tokens")
    .update({ used_at: new Date().toISOString() }, { count: "exact" })
    .eq("athlete_id", athlete.id)
    .eq("purpose", "plan_paste")
    .is("used_at", null);

  if (tokensErr) {
    console.error("Error marking link_tokens used:", tokensErr.message);
    process.exit(1);
  }

  console.log(`Deleted ${deletedVersions} plan_version row(s)`);
  console.log(`Deleted ${deletedPlansCount ?? 0} plan row(s)`);
  console.log(`Marked ${markedTokensCount ?? 0} plan_paste token(s) as used`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
