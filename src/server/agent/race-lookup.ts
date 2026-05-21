import { z } from "zod";
import { anthropicClient } from "@/lib/anthropic";
import { supabaseAdmin } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const FoundRaceSchema = z.object({
  canonical_name: z.string(),
  // nullish() accepts null or undefined — Claude may omit unknown optional fields
  date: z.string().nullish().transform((v) => v ?? null),
  distance_mi: z.number().nullish().transform((v) => v ?? null),
  elevation_ft: z.number().nullish().transform((v) => v ?? null),
  terrain: z.enum(["road", "trail", "track", "mixed"]).nullish().transform((v) => v ?? null),
  source_url: z.string().nullish().transform((v) => v ?? null),
  confidence: z.enum(["high", "medium", "low"]),
});

export type FoundRace = z.infer<typeof FoundRaceSchema>;

// Zod v4 union: both ok:true variants need z.union (not discriminatedUnion which
// requires unique discriminator values across all variants).
export const RaceLookupResultSchema = z.union([
  z.object({ ok: z.literal(true), found: FoundRaceSchema }),
  z.object({ ok: z.literal(true), ambiguous: z.array(FoundRaceSchema) }),
  z.object({ ok: z.literal(false), reason: z.enum(["not_found", "error"]) }),
]);

export type RaceLookupResult = z.infer<typeof RaceLookupResultSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SONNET_MODEL = "claude-sonnet-4-6";
const CACHE_TTL_DAYS = 30;
const MAX_LOOP_ITERS = 6;

// Cost in USD per million tokens. Sonnet 4.6 pricing.
const COST_PER_M_INPUT = 3.0;
const COST_PER_M_OUTPUT = 15.0;

// ---------------------------------------------------------------------------
// Cache key normalization
// ---------------------------------------------------------------------------

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, "")  // strip years ("2026")
    .replace(/[^a-z0-9 ]/g, " ")        // collapse punctuation to space
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a race research assistant. Given a race name, use web_search to find the official race website and verify the following details:
- Full official name
- Upcoming event date (ISO YYYY-MM-DD)
- Distance in miles
- Elevation gain in feet
- Terrain type: road, trail, track, or mixed

Confidence levels:
- "high": found the official race website with current event details
- "medium": found a credible secondary source (UltraSignup, MarathonGuide, Athlinks, RunSignUp, etc.)
- "low": found some information but from unreliable or out-of-date sources

Rules:
- Return not_found rather than guessing
- If you find multiple distinct races with the same name (e.g. different cities), return ambiguous with the candidates
- Prefer the most upcoming edition of the race
- If the race occurs in multiple years, infer the next upcoming date

Always call report_race_details with your findings. Never return a text answer.`;

// ---------------------------------------------------------------------------
// Output tool schema
// ---------------------------------------------------------------------------

const REPORT_TOOL = {
  name: "report_race_details",
  description:
    "Report the structured race details after research. Always call this tool — never return plain text.",
  input_schema: {
    type: "object" as const,
    required: ["result_type"],
    properties: {
      result_type: {
        type: "string",
        enum: ["found", "ambiguous", "not_found"],
        description: "'found' for a single match, 'ambiguous' for multiple candidates, 'not_found' if the race can't be identified",
      },
      found: {
        type: "object",
        description: "Populated when result_type is 'found'",
        properties: {
          canonical_name: { type: "string" },
          date: { type: "string", description: "ISO YYYY-MM-DD, or null" },
          distance_mi: { type: "number", description: "Distance in miles, or null" },
          elevation_ft: { type: "number", description: "Total elevation gain in feet, or null" },
          terrain: {
            type: "string",
            enum: ["road", "trail", "track", "mixed"],
            description: "Terrain type, or null",
          },
          source_url: { type: "string", description: "URL of the source, or null" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["canonical_name", "confidence"],
      },
      candidates: {
        type: "array",
        description: "Populated when result_type is 'ambiguous'. Each item has same shape as 'found'.",
        items: {
          type: "object",
          properties: {
            canonical_name: { type: "string" },
            date: { type: "string" },
            distance_mi: { type: "number" },
            elevation_ft: { type: "number" },
            terrain: { type: "string", enum: ["road", "trail", "track", "mixed"] },
            source_url: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["canonical_name", "confidence"],
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Parse Claude's tool input into RaceLookupResult
// ---------------------------------------------------------------------------

function parseToolInput(input: unknown): RaceLookupResult | null {
  const raw = input as {
    result_type?: string;
    found?: unknown;
    candidates?: unknown[];
  };

  if (!raw || typeof raw !== "object") return null;

  if (raw.result_type === "not_found") {
    return { ok: false, reason: "not_found" };
  }

  if (raw.result_type === "ambiguous" && Array.isArray(raw.candidates)) {
    const parsed = RaceLookupResultSchema.safeParse({
      ok: true,
      ambiguous: raw.candidates,
    });
    return parsed.success ? parsed.data : null;
  }

  if (raw.result_type === "found" && raw.found) {
    const parsed = RaceLookupResultSchema.safeParse({
      ok: true,
      found: raw.found,
    });
    return parsed.success ? parsed.data : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Anthropic web-search loop
// ---------------------------------------------------------------------------

type BetaMessageParam = {
  role: "user" | "assistant";
  content: unknown[];
};

async function callAnthropicWithWebSearch(
  query: string
): Promise<{ result: RaceLookupResult; inputTokens: number; outputTokens: number }> {
  const client = anthropicClient();
  const messages: BetaMessageParam[] = [
    {
      role: "user",
      content: [{ type: "text", text: `Find details for this race: "${query}"` }],
    },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let iters = 0;
  let lastRawInput: unknown = null;

  while (iters < MAX_LOOP_ITERS) {
    iters++;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client.beta.messages as any).create({
      model: SONNET_MODEL,
      max_tokens: 1024,
      betas: ["web-search-2025-03-05"],
      system: SYSTEM_PROMPT,
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        REPORT_TOOL,
      ],
      tool_choice: { type: "auto" },
      messages,
    });

    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;

    // Pause turn: server-side tools are executing. Append response and continue.
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    // Model used a client-side tool — look for report_race_details.
    if (response.stop_reason === "tool_use") {
      const toolUse = (response.content as unknown[]).find(
        (b: unknown) =>
          (b as { type?: string; name?: string }).type === "tool_use" &&
          (b as { type?: string; name?: string }).name === "report_race_details"
      ) as { input?: unknown } | undefined;

      if (toolUse?.input !== undefined) {
        lastRawInput = toolUse.input;
        const result = parseToolInput(toolUse.input);
        if (result) return { result, inputTokens, outputTokens };

        // Zod validation failed — retry once with corrected output prompt.
        if (iters === 1) {
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: `Your report_race_details output was malformed. Raw input received: ${JSON.stringify(lastRawInput)}. Please call report_race_details again with valid data matching the schema.`,
              },
            ],
          });
          continue;
        }
        // Second failure — give up rather than looping further.
        return { result: { ok: false, reason: "error" }, inputTokens, outputTokens };
      }

      // No valid report_race_details found — retry with forced tool choice.
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "Please call report_race_details with your findings now.",
          },
        ],
      });
      continue;
    }

    // End turn without tool use — force the output tool.
    if (response.stop_reason === "end_turn") {
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "Please now call report_race_details with your findings.",
          },
        ],
      });
      continue;
    }

    // Unexpected stop reason
    break;
  }

  return {
    result: { ok: false, reason: "error" },
    inputTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

async function getCached(nameKey: string): Promise<RaceLookupResult | null> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("race_lookups")
    .select("result, expires_at")
    .eq("name_lower", nameKey)
    .maybeSingle();

  if (!data) return null;
  if (new Date(data.expires_at) <= new Date()) return null; // expired

  const parsed = RaceLookupResultSchema.safeParse(data.result);
  return parsed.success ? parsed.data : null;
}

async function writeCache(nameKey: string, result: RaceLookupResult): Promise<void> {
  const db = supabaseAdmin();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS);

  await db.from("race_lookups").upsert(
    {
      name_lower: nameKey,
      result: result as unknown as Record<string, unknown>,
      expires_at: expiresAt.toISOString(),
    },
    { onConflict: "name_lower" }
  );
}

// ---------------------------------------------------------------------------
// agent_runs persistence
// ---------------------------------------------------------------------------

async function persistRun(
  athleteId: string,
  startedAt: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  const costUsd =
    (inputTokens / 1_000_000) * COST_PER_M_INPUT +
    (outputTokens / 1_000_000) * COST_PER_M_OUTPUT;

  await supabaseAdmin().from("agent_runs").insert({
    athlete_id: athleteId,
    kind: "race_lookup",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    model: SONNET_MODEL,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function lookupRace(
  name: string,
  athleteId?: string
): Promise<RaceLookupResult> {
  const nameKey = normalizeName(name);

  // Cache hit
  const cached = await getCached(nameKey);
  if (cached) return cached;

  // Cache miss — call Anthropic
  const startedAt = new Date().toISOString();
  let result: RaceLookupResult;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const out = await callAnthropicWithWebSearch(name);
    result = out.result;
    inputTokens = out.inputTokens;
    outputTokens = out.outputTokens;
  } catch {
    result = { ok: false, reason: "error" };
  }

  // Persist to cache (even not_found, to avoid hammering the API for unknown races)
  await writeCache(nameKey, result).catch(() => {/* non-fatal */});

  // Persist agent_run if we have an athlete context
  if (athleteId) {
    await persistRun(athleteId, startedAt, inputTokens, outputTokens).catch(() => {/* non-fatal */});
  }

  return result;
}
