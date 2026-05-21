import { supabaseAdmin } from "@/lib/db";
import { anthropicClient } from "@/lib/anthropic";
import { lookupRace, type FoundRace, type RaceLookupResult } from "@/server/agent/race-lookup";
import { upsertMemorySection } from "../memory";
import type { OnboardingStep, StepHandleResult } from "../types";
import { parseDateFlexible } from "../parsing/dates";
import { parseFinishTime, formatFinishTime } from "../parsing/durations";
import { parseDistanceMiles } from "../parsing/distance";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Sub-flow state
// ---------------------------------------------------------------------------

type ManualRacePartial = {
  name: string;
  date?: string;
  distance_mi?: number;
  elevation_ft?: number;
  terrain?: string;
};

type ConfirmedRace = {
  name: string;
  date: string | null;
  distance_mi: number | null;
  elevation_ft: number | null;
  terrain: string | null;
  source_url: string | null;
};

type SubStep =
  | "goal_name"
  | "goal_confirm"
  | "goal_manual_date"
  | "goal_manual_distance"
  | "goal_manual_elevation"
  | "goal_manual_terrain"
  | "tuneup_loop"
  | "tuneup_confirm"
  | "tuneup_manual_date"
  | "tuneup_manual_distance"
  | "tuneup_manual_elevation"
  | "tuneup_manual_terrain"
  | "past_race";

type Step2Partial = {
  sub_step: SubStep;
  goal_race?: ConfirmedRace;
  goal_lookup?: RaceLookupResult;
  goal_manual?: ManualRacePartial;
  tuneups: ConfirmedRace[];
  tuneup_current_name?: string;
  tuneup_current_lookup?: RaceLookupResult;
  tuneup_manual?: ManualRacePartial;
  past_race?: { name: string; finish_time_seconds: number | null; date: string | null } | null;
  past_race_attempts?: number;
};

function asPartial(p: Record<string, unknown>): Step2Partial {
  return p as Step2Partial;
}

// ---------------------------------------------------------------------------
// Terrain parsing
// ---------------------------------------------------------------------------

function parseTerrain(text: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = text.trim().toLowerCase();
  if (v.includes("road") || v.includes("pave")) return { ok: true, value: "road" };
  if (v.includes("trail") || v.includes("mountain") || v.includes("dirt")) return { ok: true, value: "trail" };
  if (v.includes("track") || v.includes("oval")) return { ok: true, value: "track" };
  if (v.includes("mix")) return { ok: true, value: "mixed" };
  return { ok: false, error: 'Send one of: road, trail, track, or mixed.' };
}

// ---------------------------------------------------------------------------
// Confirmation message helpers
// ---------------------------------------------------------------------------

function raceDetailsLine(r: FoundRace | ConfirmedRace): string {
  const parts: string[] = [];
  if (r.date) parts.push(r.date);
  if (r.distance_mi) parts.push(`${r.distance_mi} mi`);
  if (r.terrain) parts.push(r.terrain);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function confirmPrompt(
  label: string,
  race: FoundRace,
  confidence: "high" | "medium" | "low"
): string {
  const qualifier = confidence === "high" ? "" : "Possible match: ";
  return `${qualifier}${label}: ${race.canonical_name}${raceDetailsLine(race)}\n\nIs that right? Reply yes / no / wrong`;
}

// ---------------------------------------------------------------------------
// Shared confirmation sub-flow for goal and tune-up races
// A "context" tells us which set of state fields to read/write.
// ---------------------------------------------------------------------------

type RaceContext = "goal" | "tuneup";

function getLookup(p: Step2Partial, ctx: RaceContext): RaceLookupResult | undefined {
  return ctx === "goal" ? p.goal_lookup : p.tuneup_current_lookup;
}

function withLookup(p: Step2Partial, ctx: RaceContext, lookup: RaceLookupResult): Step2Partial {
  if (ctx === "goal") return { ...p, goal_lookup: lookup };
  return { ...p, tuneup_current_lookup: lookup };
}

function manualField(ctx: RaceContext): "goal_manual" | "tuneup_manual" {
  return ctx === "goal" ? "goal_manual" : "tuneup_manual";
}

function manualDateStep(ctx: RaceContext): SubStep {
  return ctx === "goal" ? "goal_manual_date" : "tuneup_manual_date";
}

function manualDistStep(ctx: RaceContext): SubStep {
  return ctx === "goal" ? "goal_manual_distance" : "tuneup_manual_distance";
}

function manualElevStep(ctx: RaceContext): SubStep {
  return ctx === "goal" ? "goal_manual_elevation" : "tuneup_manual_elevation";
}

function manualTerrStep(ctx: RaceContext): SubStep {
  return ctx === "goal" ? "goal_manual_terrain" : "tuneup_manual_terrain";
}

function confirmStep(ctx: RaceContext): SubStep {
  return ctx === "goal" ? "goal_confirm" : "tuneup_confirm";
}

function afterConfirm(ctx: RaceContext): SubStep {
  return ctx === "goal" ? "tuneup_loop" : "tuneup_loop";
}

function setConfirmedRace(p: Step2Partial, ctx: RaceContext, race: ConfirmedRace): Step2Partial {
  if (ctx === "goal") return { ...p, goal_race: race };
  return { ...p, tuneups: [...p.tuneups, race] };
}

function getManualName(p: Step2Partial, ctx: RaceContext): string {
  const m = p[manualField(ctx)];
  return m?.name ?? (ctx === "goal" ? "your goal race" : "this race");
}

// ---------------------------------------------------------------------------
// After a race name is provided, look it up and return the appropriate reply
// ---------------------------------------------------------------------------

async function handleRaceName(
  name: string,
  athleteId: string,
  p: Step2Partial,
  ctx: RaceContext
): Promise<StepHandleResult> {
  const lookup = await lookupRace(name, athleteId);

  if (!lookup.ok) {
    // not_found or error
    const manualName = name;
    const newPartial: Step2Partial = {
      ...withLookup(p, ctx, lookup),
      [manualField(ctx)]: { name: manualName },
      sub_step: manualDateStep(ctx),
    };
    return {
      done: false,
      newPartial: newPartial as Record<string, unknown>,
      reply: `Couldn't find "${name}". Let me collect the details manually.\n\nWhat's the race date? (e.g. Oct 4 2026 or 2026-10-04)`,
    };
  }

  if ("ambiguous" in lookup) {
    const list = lookup.ambiguous
      .map((r, i) => `${i + 1}. ${r.canonical_name}${raceDetailsLine(r)}`)
      .join("\n");
    return {
      done: false,
      newPartial: {
        ...withLookup(p, ctx, lookup),
        [manualField(ctx)]: { name },
        sub_step: confirmStep(ctx),
      } as Record<string, unknown>,
      reply: `Found a few races with that name:\n\n${list}\n\nWhich one? Reply 1, 2, 3, etc. — or "none" to enter details manually.`,
    };
  }

  // Single found result
  const found = lookup.found;
  return {
    done: false,
    newPartial: {
      ...withLookup(p, ctx, lookup),
      [manualField(ctx)]: { name: found.canonical_name },
      sub_step: confirmStep(ctx),
    } as Record<string, unknown>,
    reply: confirmPrompt(ctx === "goal" ? "Goal race" : "Tune-up", found, found.confidence),
  };
}

// ---------------------------------------------------------------------------
// Handle confirm step (yes/no/wrong/number)
// ---------------------------------------------------------------------------

function handleConfirm(
  text: string,
  p: Step2Partial,
  ctx: RaceContext
): StepHandleResult {
  const v = text.trim().toLowerCase();
  const lookup = getLookup(p, ctx);

  // Affirmative
  if (v === "yes" || v === "y" || v === "correct" || v === "right") {
    let race: ConfirmedRace | undefined;

    if (lookup && lookup.ok && "found" in lookup) {
      const f = lookup.found;
      race = {
        name: f.canonical_name,
        date: f.date ?? null,
        distance_mi: f.distance_mi ?? null,
        elevation_ft: f.elevation_ft ?? null,
        terrain: f.terrain ?? null,
        source_url: f.source_url ?? null,
      };
    }

    if (!race) {
      // Shouldn't happen, but fall through to manual if no lookup cached
      return {
        done: false,
        newPartial: { ...p, sub_step: manualDateStep(ctx) } as Record<string, unknown>,
        reply: "What's the race date? (e.g. Oct 4 2026)",
      };
    }

    const newPartial = setConfirmedRace(p, ctx, race);
    return nextAfterRace(newPartial, ctx);
  }

  // Number (ambiguous selection)
  const num = parseInt(v, 10);
  if (!isNaN(num) && lookup?.ok && "ambiguous" in lookup) {
    const chosen = lookup.ambiguous[num - 1];
    if (chosen) {
      const race: ConfirmedRace = {
        name: chosen.canonical_name,
        date: chosen.date ?? null,
        distance_mi: chosen.distance_mi ?? null,
        elevation_ft: chosen.elevation_ft ?? null,
        terrain: chosen.terrain ?? null,
        source_url: chosen.source_url ?? null,
      };
      const newPartial = setConfirmedRace(p, ctx, race);
      return nextAfterRace(newPartial, ctx);
    }
    return {
      done: false,
      newPartial: p as Record<string, unknown>,
      reply: `Please reply with a number between 1 and ${lookup.ambiguous.length}, or "none" to enter details manually.`,
    };
  }

  // None / no / wrong — go manual
  if (
    v === "no" ||
    v === "n" ||
    v === "wrong" ||
    v === "none" ||
    v === "manual" ||
    v === "skip"
  ) {
    const name = getManualName(p, ctx);
    return {
      done: false,
      newPartial: {
        ...p,
        [manualField(ctx)]: { name },
        sub_step: manualDateStep(ctx),
      } as Record<string, unknown>,
      reply: "No problem. What's the race date? (e.g. Oct 4 2026, or 'skip' if unknown)",
    };
  }

  return {
    done: false,
    newPartial: p as Record<string, unknown>,
    reply: "Reply yes / no / wrong, or a number to pick from the list.",
  };
}

// ---------------------------------------------------------------------------
// After a race is confirmed, decide the next sub-step
// ---------------------------------------------------------------------------

function nextAfterRace(p: Step2Partial, ctx: RaceContext): StepHandleResult {
  const next = afterConfirm(ctx);
  if (next === "tuneup_loop") {
    const count = p.tuneups.length;
    const countLine =
      count === 4 ? "\n\n⚠️ You're at 4 tune-ups — max is 6." : "";
    return {
      done: false,
      newPartial: { ...p, sub_step: "tuneup_loop" } as Record<string, unknown>,
      reply: `Got it.${countLine}\n\nAny tune-up races before your goal? Send a name or "done" to skip.`,
    };
  }
  return {
    done: false,
    newPartial: { ...p, sub_step: next } as Record<string, unknown>,
    reply: "Got it. What's next?",
  };
}

// ---------------------------------------------------------------------------
// Manual correction sub-flow
// ---------------------------------------------------------------------------

function handleManualDate(
  text: string,
  p: Step2Partial,
  ctx: RaceContext
): StepHandleResult {
  const v = text.trim().toLowerCase();
  const field = manualField(ctx);
  const manual = p[field] ?? { name: "unknown" };

  if (v === "skip" || v === "unknown" || v === "tbd") {
    return {
      done: false,
      newPartial: { ...p, [field]: { ...manual, date: null }, sub_step: manualDistStep(ctx) } as Record<string, unknown>,
      reply: "What's the distance? (e.g. 26.2 mi, 42.2 km, marathon, half)",
    };
  }

  const result = parseDateFlexible(text);
  if (!result.ok) {
    return {
      done: false,
      newPartial: p as Record<string, unknown>,
      reply: `${result.error} Send the race date (or 'skip'):`,
    };
  }

  return {
    done: false,
    newPartial: {
      ...p,
      [field]: { ...manual, date: result.value },
      sub_step: manualDistStep(ctx),
    } as Record<string, unknown>,
    reply: "What's the distance? (e.g. 26.2 mi, 42.2 km, marathon, half)",
  };
}

function handleManualDistance(
  text: string,
  p: Step2Partial,
  ctx: RaceContext
): StepHandleResult {
  const field = manualField(ctx);
  const manual = p[field] ?? { name: "unknown" };

  const result = parseDistanceMiles(text);
  if (!result.ok) {
    return {
      done: false,
      newPartial: p as Record<string, unknown>,
      reply: `${result.error}`,
    };
  }

  return {
    done: false,
    newPartial: {
      ...p,
      [field]: { ...manual, distance_mi: result.value },
      sub_step: manualElevStep(ctx),
    } as Record<string, unknown>,
    reply: "Elevation gain in feet? (e.g. 2500, or 'skip')",
  };
}

function handleManualElevation(
  text: string,
  p: Step2Partial,
  ctx: RaceContext
): StepHandleResult {
  const field = manualField(ctx);
  const manual = p[field] ?? { name: "unknown" };
  const v = text.trim().toLowerCase();

  let elevation: number | null = null;
  if (v !== "skip" && v !== "unknown" && v !== "tbd") {
    const n = parseFloat(v.replace(/[,\s]/g, ""));
    if (isNaN(n) || n < 0) {
      return {
        done: false,
        newPartial: p as Record<string, unknown>,
        reply: "Send elevation in feet as a number (e.g. 2500), or 'skip'.",
      };
    }
    elevation = n;
  }

  return {
    done: false,
    newPartial: {
      ...p,
      [field]: { ...manual, elevation_ft: elevation },
      sub_step: manualTerrStep(ctx),
    } as Record<string, unknown>,
    reply: "Terrain type? (road / trail / track / mixed, or 'skip')",
  };
}

function handleManualTerrain(
  text: string,
  p: Step2Partial,
  ctx: RaceContext
): StepHandleResult {
  const field = manualField(ctx);
  const manual = p[field] ?? { name: "unknown" };
  const v = text.trim().toLowerCase();

  let terrain: string | null = null;
  if (v !== "skip" && v !== "unknown") {
    const result = parseTerrain(text);
    if (!result.ok) {
      return {
        done: false,
        newPartial: p as Record<string, unknown>,
        reply: `${result.error} (or 'skip')`,
      };
    }
    terrain = result.value;
  }

  const race: ConfirmedRace = {
    name: manual.name ?? "unknown",
    date: manual.date ?? null,
    distance_mi: manual.distance_mi ?? null,
    elevation_ft: manual.elevation_ft ?? null,
    terrain,
    source_url: null,
  };

  const newPartial = setConfirmedRace({ ...p, [field]: undefined }, ctx, race);
  return nextAfterRace(newPartial, ctx);
}

// ---------------------------------------------------------------------------
// Haiku call for past race parsing
// ---------------------------------------------------------------------------

const PastRaceSchema = z.object({
  name: z.string(),
  finish_time_seconds: z.number().nullable(),
  date: z.string().nullable(),
});

type PastRace = z.infer<typeof PastRaceSchema>;

const PAST_RACE_TOOL = {
  name: "parse_past_race",
  description: "Parse an athlete's description of their best race into structured data.",
  input_schema: {
    type: "object" as const,
    required: ["name"],
    properties: {
      name: { type: "string", description: "Race name" },
      finish_time_seconds: { type: "number", description: "Finish time in seconds, or null if unknown" },
      date: { type: "string", description: "Date as ISO YYYY-MM-DD, or null if unknown" },
    },
  },
} as const;

async function parsePastRace(text: string): Promise<PastRace | null> {
  const client = anthropicClient();

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client.messages as any).create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:
        "Parse the athlete's race description into structured JSON. Extract race name, finish time (in seconds), and date. Return null for fields you can't determine.",
      tools: [PAST_RACE_TOOL],
      tool_choice: { type: "tool", name: "parse_past_race" },
      messages: [
        { role: "user", content: text },
      ],
    });

    const toolUse = (response.content as unknown[]).find(
      (b: unknown) =>
        (b as { type?: string; name?: string }).type === "tool_use" &&
        (b as { type?: string; name?: string }).name === "parse_past_race"
    ) as { input?: unknown } | undefined;

    if (!toolUse?.input) return null;

    const parsed = PastRaceSchema.safeParse(toolUse.input);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Skip keywords for past race
// ---------------------------------------------------------------------------

function isSkipPastRace(text: string): boolean {
  const v = text.trim().toLowerCase();
  return (
    v === "skip" ||
    v === "none" ||
    v === "no" ||
    v === "n/a" ||
    v === "never" ||
    v === "nope" ||
    v.startsWith("never done") ||
    v.startsWith("no notable") ||
    v.startsWith("haven")
  );
}

// ---------------------------------------------------------------------------
// Main handleMessage dispatcher
// ---------------------------------------------------------------------------

async function racesHandleMessage(
  text: string,
  partialRaw: Record<string, unknown>,
  athleteId: string
): Promise<StepHandleResult> {
  // Initialize state on first message
  const p: Step2Partial =
    Object.keys(partialRaw).length === 0
      ? { sub_step: "goal_name", tuneups: [] }
      : asPartial(partialRaw);

  switch (p.sub_step) {
    // ---- 2a: Goal race name ----
    case "goal_name": {
      const v = text.trim();
      if (v.length < 2 || v.length > 120) {
        return {
          done: false,
          newPartial: p as Record<string, unknown>,
          reply: "Send the name of your goal race (2–120 characters).",
        };
      }
      return handleRaceName(v, athleteId, p, "goal");
    }

    // ---- 2b: Goal race confirmation ----
    case "goal_confirm":
      return handleConfirm(text, p, "goal");

    // ---- 2c: Goal race manual correction ----
    case "goal_manual_date":
      return handleManualDate(text, p, "goal");
    case "goal_manual_distance":
      return handleManualDistance(text, p, "goal");
    case "goal_manual_elevation":
      return handleManualElevation(text, p, "goal");
    case "goal_manual_terrain":
      return handleManualTerrain(text, p, "goal");

    // ---- 2d: Tune-up loop ----
    case "tuneup_loop": {
      const v = text.trim();

      if (v.toLowerCase() === "done") {
        return {
          done: false,
          newPartial: { ...p, sub_step: "past_race" } as Record<string, unknown>,
          reply:
            "Got it.\n\nWhat's your best race result so far? Something like \"Boston Marathon 2024, 3:52:14\" — or 'skip' if you haven't raced.",
        };
      }

      if (p.tuneups.length >= 6) {
        return {
          done: false,
          newPartial: p as Record<string, unknown>,
          reply: "You've already hit the 6 tune-up limit. Reply 'done' to continue.",
        };
      }

      if (v.length < 2 || v.length > 120) {
        return {
          done: false,
          newPartial: p as Record<string, unknown>,
          reply: "Send a race name, or 'done' to move on.",
        };
      }

      return handleRaceName(
        v,
        athleteId,
        { ...p, tuneup_current_name: v },
        "tuneup"
      );
    }

    // ---- 2d continued: Tune-up confirmation ----
    case "tuneup_confirm":
      return handleConfirm(text, p, "tuneup");

    case "tuneup_manual_date":
      return handleManualDate(text, p, "tuneup");
    case "tuneup_manual_distance":
      return handleManualDistance(text, p, "tuneup");
    case "tuneup_manual_elevation":
      return handleManualElevation(text, p, "tuneup");
    case "tuneup_manual_terrain":
      return handleManualTerrain(text, p, "tuneup");

    // ---- 2e: Past notable race ----
    case "past_race": {
      if (isSkipPastRace(text)) {
        const finalPartial: Step2Partial = { ...p, past_race: null };
        return { done: true, newPartial: finalPartial as Record<string, unknown> };
      }

      const attempts = p.past_race_attempts ?? 0;
      const parsed = await parsePastRace(text);

      if (parsed) {
        const finalPartial: Step2Partial = {
          ...p,
          past_race: {
            name: parsed.name,
            finish_time_seconds: parsed.finish_time_seconds,
            date: parsed.date,
          },
        };
        return { done: true, newPartial: finalPartial as Record<string, unknown> };
      }

      // Second failure — accept raw text with null times
      if (attempts >= 1) {
        const finalPartial: Step2Partial = {
          ...p,
          past_race: { name: text.trim(), finish_time_seconds: null, date: null },
        };
        return { done: true, newPartial: finalPartial as Record<string, unknown> };
      }

      return {
        done: false,
        newPartial: {
          ...p,
          past_race_attempts: attempts + 1,
          sub_step: "past_race",
        } as Record<string, unknown>,
        reply:
          "Couldn't parse that. Try something like \"Boston Marathon 2024, 3:52:14\" or just \"Boston Marathon 2024\" — or 'skip' to move on.",
      };
    }

    default: {
      // Unknown sub_step — reset to goal_name
      return {
        done: false,
        newPartial: { sub_step: "goal_name", tuneups: [] } as Record<string, unknown>,
        reply: "Let's start over. What race are you training for?",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// onComplete: writes races + memory files
// ---------------------------------------------------------------------------

// Read step-1 target_type and target_time_sec from athletes.notes
async function readStep1Target(
  athleteId: string
): Promise<{ targetType: "finish" | "time"; targetTimeSec: number | null }> {
  const { data } = await supabaseAdmin()
    .from("athletes")
    .select("notes")
    .eq("id", athleteId)
    .maybeSingle();

  const notes = data?.notes ?? "";
  const isTime =
    /target:\s*finish in a goal time/i.test(notes) ||
    /goal type:\s*time goal/i.test(notes);

  let targetTimeSec: number | null = null;
  const timeMatch = /target time:\s*(\d+):(\d+):(\d+)/i.exec(notes);
  if (timeMatch) {
    targetTimeSec =
      parseInt(timeMatch[1]!, 10) * 3600 +
      parseInt(timeMatch[2]!, 10) * 60 +
      parseInt(timeMatch[3]!, 10);
  }

  return { targetType: isTime ? "time" : "finish", targetTimeSec };
}

async function racesOnComplete(
  athleteId: string,
  partialRaw: Record<string, unknown>
): Promise<void> {
  const p = asPartial(partialRaw);
  const db = supabaseAdmin();

  // --- 1. Races table rows ---

  const { targetType, targetTimeSec } = await readStep1Target(athleteId);

  if (p.goal_race) {
    await db.from("races").insert({
      athlete_id: athleteId,
      name: p.goal_race.name,
      date: p.goal_race.date,
      distance_mi: p.goal_race.distance_mi,
      elevation_ft: p.goal_race.elevation_ft,
      terrain: p.goal_race.terrain,
      target_type: targetType,
      target_time_sec: targetType === "time" ? targetTimeSec : null,
      status: "upcoming",
    });
  }

  for (const t of p.tuneups) {
    await db.from("races").insert({
      athlete_id: athleteId,
      name: t.name,
      date: t.date,
      distance_mi: t.distance_mi,
      elevation_ft: t.elevation_ft,
      terrain: t.terrain,
      target_type: "finish",
      target_time_sec: null,
      status: "upcoming",
    });
  }

  if (p.past_race) {
    await db.from("races").insert({
      athlete_id: athleteId,
      name: p.past_race.name,
      date: p.past_race.date,
      distance_mi: null,
      elevation_ft: null,
      terrain: null,
      target_type: null,
      target_time_sec: null,
      status: "completed",
    });
  }

  // --- 2. race_calendar.md ---

  const upcomingRaces = [
    ...(p.goal_race ? [{ ...p.goal_race, label: "Goal" }] : []),
    ...p.tuneups.map((t) => ({ ...t, label: "Tune-up" })),
  ].sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));

  const upcomingRows = upcomingRaces
    .map((r) => {
      const date = r.date ?? "TBD";
      const dist = r.distance_mi ? `${r.distance_mi} mi` : "—";
      const target =
        r === upcomingRaces[0] && targetType === "time" && targetTimeSec
          ? formatFinishTime(targetTimeSec)
          : "Finish";
      return `| ${date} | ${r.name} | ${dist} | ${target} |`;
    })
    .join("\n");

  const calendarSections: string[] = [];

  if (upcomingRows) {
    calendarSections.push(
      `## Upcoming races\n| Date | Race | Distance | Target |\n|------|------|----------|--------|\n${upcomingRows}`
    );
  }

  if (p.past_race) {
    const pr = p.past_race;
    const prDate = pr.date ?? "—";
    const prTime = pr.finish_time_seconds ? formatFinishTime(pr.finish_time_seconds) : "—";
    const pastTable =
      `## Past races\n| Date | Race | Finish time |\n|------|------|------------|\n` +
      `| ${prDate} | ${pr.name} | ${prTime} |`;
    calendarSections.push(pastTable);
  }

  if (calendarSections.length > 0) {
    // race_calendar.md uses sections directly, not athlete_profile.md
    const db2 = supabaseAdmin();
    const { data: existing } = await db2
      .from("memory_files")
      .select("content_md")
      .eq("athlete_id", athleteId)
      .eq("file_name", "race_calendar.md")
      .maybeSingle();

    // Replace or create the entire file
    const content = calendarSections.join("\n\n");
    const current = existing?.content_md ?? "";
    const updated = rebuildCalendar(current, content);

    await db2.from("memory_files").upsert(
      {
        athlete_id: athleteId,
        file_name: "race_calendar.md",
        content_md: updated,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "athlete_id,file_name" }
    );
  }

  // --- 3. personal_records.md ---

  if (p.past_race && p.past_race.finish_time_seconds != null) {
    const pr = p.past_race;
    const finishSeconds = pr.finish_time_seconds!;
    const time = formatFinishTime(finishSeconds);
    const datePart = pr.date ? ` (${pr.date})` : "";
    const prLine = `${pr.name}${datePart} — ${time}`;

    await upsertMemorySection(athleteId, "personal_records.md", "PR baseline", prLine);
  }
}

// Rebuild the race_calendar.md replacing it in full with new section content
function rebuildCalendar(_existing: string, newContent: string): string {
  return newContent;
}

// ---------------------------------------------------------------------------
// Step export
// ---------------------------------------------------------------------------

// Step 2 uses handleMessage instead of the questions array.
// Reason: the sub-flow requires async operations (lookupRace) in the parse step
// and sends different prompts per branch — both are incompatible with the
// synchronous Question.parseReply + static Question.prompt contract.
// The handleMessage extension adds ~10 dispatcher lines and zero changes to
// steps 0, 1, 3, 4, 5.
// Step 2 uses handleMessage instead of the questions array.
// Reason: the sub-flow requires async operations (lookupRace) in the parse step
// and sends different prompts per branch — both incompatible with the synchronous
// Question.parseReply + static Question.prompt contract.
// The handleMessage extension adds ~10 dispatcher lines and zero changes to
// steps 0, 1, 3, 4, 5.
export const racesStep: OnboardingStep = {
  id: "races",
  questions: [],
  initialPrompt:
    "What race are you training for? Just the name — like 'Boston Marathon' or 'Chicago Marathon'.",
  handleMessage: racesHandleMessage,
  onComplete: racesOnComplete,
};
