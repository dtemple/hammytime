import "dotenv/config";
import { supabaseAdmin } from "../src/lib/db";

const client = supabaseAdmin();

// Query a non-existent table: a "relation does not exist" error (42P01)
// still proves we connected to Postgres successfully.
const { error } = await client.from("_smoke_probe").select("*").limit(1);

if (!error || error.code === "42P01") {
  console.log("db-smoke: connection OK");
  process.exit(0);
} else {
  console.error("db-smoke: connection failed", error);
  process.exit(1);
}
