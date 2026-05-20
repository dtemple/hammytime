import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "../src/lib/db";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("Usage: npm run seed:allowlist -- <email>");
    process.exit(1);
  }

  const db = supabaseAdmin();
  const { error } = await db
    .from("friend_allowlist")
    .upsert({ email }, { onConflict: "email", ignoreDuplicates: true });

  if (error) {
    console.error("seed-allowlist: failed", error);
    process.exit(1);
  }

  console.log(`seed-allowlist: ${email} is on the allowlist`);
}

main();
