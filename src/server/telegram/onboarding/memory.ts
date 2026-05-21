import { supabaseAdmin } from "@/lib/db";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function upsertMemorySection(
  athleteId: string,
  fileName: string,
  sectionName: string,
  content: string
): Promise<void> {
  const db = supabaseAdmin();

  const { data } = await db
    .from("memory_files")
    .select("content_md")
    .eq("athlete_id", athleteId)
    .eq("file_name", fileName)
    .maybeSingle();

  const existing = data?.content_md ?? "";

  const pattern = new RegExp(
    `## ${escapeRegex(sectionName)}[\\s\\S]*?(?=\\n## |$)`
  );
  const newBlock = `## ${sectionName}\n${content}`;

  let updated: string;
  if (pattern.test(existing)) {
    updated = existing.replace(pattern, newBlock);
  } else {
    updated = existing === "" ? newBlock : `${existing}\n\n${newBlock}`;
  }

  const { error } = await db.from("memory_files").upsert(
    {
      athlete_id: athleteId,
      file_name: fileName,
      content_md: updated,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "athlete_id,file_name" }
  );

  if (error) throw new Error(`upsertMemorySection(${fileName}) failed: ${error.message}`);
}

export async function upsertProfileSection(
  athleteId: string,
  sectionName: string,
  content: string
): Promise<void> {
  return upsertMemorySection(athleteId, "athlete_profile.md", sectionName, content);
}
