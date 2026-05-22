import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/db";
import {
  loadAthleteData,
  buildTemplateValues,
  renderBYOPlanTemplate,
} from "@/server/agent/byo-plan";
import { CopyableTemplate } from "./CopyableTemplate";
import { PasteForm } from "./PasteForm";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function PastePage({ params }: Props) {
  const { token } = await params;
  const db = supabaseAdmin();

  const { data: linkToken } = await db
    .from("link_tokens")
    .select("id, athlete_id, plan_version_id, expires_at, used_at")
    .eq("token", token)
    .eq("purpose", "plan_paste")
    .maybeSingle();

  if (
    !linkToken ||
    !linkToken.athlete_id ||
    linkToken.used_at ||
    new Date(linkToken.expires_at) < new Date()
  ) {
    notFound();
  }

  // Load athlete data to re-render the prompt
  let renderedPrompt: string;
  let athleteName: string;
  let raceName: string;
  let raceDate: string | null;

  try {
    const data = await loadAthleteData(linkToken.athlete_id);
    const values = buildTemplateValues(data);
    renderedPrompt = await renderBYOPlanTemplate(values);
    athleteName = data.athlete.name;
    raceName = data.goalRace?.name ?? "your goal race";
    raceDate = data.goalRace?.date ?? null;
  } catch {
    notFound();
  }

  return (
    <main className="min-h-screen bg-white py-12 px-4 max-w-3xl mx-auto space-y-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-gray-900">{athleteName}&rsquo;s training plan</h1>
        <p className="text-gray-500 text-sm">
          {raceName}
          {raceDate ? ` — ${raceDate}` : ""}
        </p>
      </header>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-medium text-gray-800">Step 1 — Copy this prompt</h2>
          <p className="text-sm text-gray-500">
            Paste it into Claude or ChatGPT. Work with it until the plan feels right. When you&rsquo;re done,
            copy only the final JSON from between the <code className="font-mono text-xs">&lt;plan-json&gt;</code>{" "}
            markers.
          </p>
        </div>
        <CopyableTemplate prompt={renderedPrompt} />
      </section>

      <hr className="border-gray-200" />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-medium text-gray-800">Step 2 — Paste your plan JSON</h2>
          <p className="text-sm text-gray-500">
            Paste the JSON between the markers here. I&rsquo;ll validate it against the safety rules and
            activate it if everything looks good.
          </p>
        </div>
        <PasteForm token={token} />
      </section>
    </main>
  );
}
