import { supabaseAdmin } from "@/lib/db";
import Link from "next/link";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function PasteDonePage({ params }: Props) {
  const { token } = await params;
  const db = supabaseAdmin();

  // Look up the token — used_at will now be set
  const { data: linkToken } = await db
    .from("link_tokens")
    .select("athlete_id, plan_version_id, used_at")
    .eq("token", token)
    .eq("purpose", "plan_paste")
    .maybeSingle();

  if (!linkToken) {
    return (
      <main className="min-h-screen bg-white py-12 px-4 max-w-xl mx-auto space-y-6">
        <h1 className="text-2xl font-semibold text-gray-900">Link not found</h1>
        <p className="text-gray-500 text-sm">
          This link isn&rsquo;t valid.{" "}
          <Link href="/signup" className="underline">
            Back to signup
          </Link>
        </p>
      </main>
    );
  }

  // Fetch the active plan version for a summary
  let summary = "";
  if (linkToken.plan_version_id) {
    const { data: version } = await db
      .from("plan_versions")
      .select("plan_json, status")
      .eq("id", linkToken.plan_version_id)
      .maybeSingle();

    if (version?.status === "active" && version.plan_json) {
      try {
        const plan = version.plan_json as {
          meta?: { total_weeks?: number; goal_race?: { name?: string }; start_date?: string };
          weeks?: { planned_volume_mi?: number }[];
        };
        const totalWeeks = plan.meta?.total_weeks;
        const raceName = plan.meta?.goal_race?.name;
        const startDate = plan.meta?.start_date;
        const peakVolume = plan.weeks
          ? Math.max(...plan.weeks.map((w) => w.planned_volume_mi ?? 0))
          : null;

        const parts: string[] = [];
        if (totalWeeks) parts.push(`${totalWeeks}-week plan`);
        if (raceName) parts.push(`for ${raceName}`);
        if (startDate) parts.push(`starting ${startDate}`);
        if (peakVolume) parts.push(`peak ${peakVolume} mi/wk`);
        summary = parts.join(", ");
      } catch {
        // non-critical
      }
    }
  }

  return (
    <main className="min-h-screen bg-white py-12 px-4 max-w-xl mx-auto space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-gray-900">Plan received.</h1>
        {summary && <p className="text-gray-600 text-sm">{summary}.</p>}
      </header>

      <p className="text-gray-600 text-sm">
        Your plan passed all safety checks and is now active. You&rsquo;ll get a confirmation in Telegram
        shortly.
      </p>

      <p className="text-gray-500 text-sm font-medium">
        Return to Telegram — daily check-ins will start once the coaching loop ships.
      </p>
    </main>
  );
}
