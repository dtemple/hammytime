import { supabaseAdmin } from "@/lib/db";
import { upsertProfileSection } from "../memory";
import type { OnboardingStep, ParseResult, Question } from "../types";

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

type Distance = "5k" | "10k" | "half" | "marathon" | "ultra";
type Target = "time" | "finish";

function parseDistance(text: string): ParseResult<Distance> {
  const v = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^5\s*k(m)?$/.test(v)) return { ok: true, value: "5k" };
  if (/^10\s*k(m)?$/.test(v)) return { ok: true, value: "10k" };
  if (/^half(\s+marathon)?$/.test(v) || v === "hm" || v === "13.1")
    return { ok: true, value: "half" };
  if (
    /^(full\s+)?marathon$/.test(v) ||
    v === "26.2" ||
    v === "m" ||
    v === "full"
  )
    return { ok: true, value: "marathon" };
  if (/^ultra(marathon)?$/.test(v) || v === "50k" || v === "50m" || v === "100m" || v === "100k")
    return { ok: true, value: "ultra" };
  return {
    ok: false,
    error: "Send one of: 5k, 10k, half, marathon, or ultra.",
  };
}

function parseTarget(text: string): ParseResult<Target> {
  const v = text.trim().toLowerCase();
  if (
    v.includes("time") ||
    v.includes("pr") ||
    v.includes("pb") ||
    v === "goal time" ||
    v === "fast"
  )
    return { ok: true, value: "time" };
  if (
    v.includes("finish") ||
    v.includes("complete") ||
    v === "just finish" ||
    v === "completion" ||
    v === "f"
  )
    return { ok: true, value: "finish" };
  return {
    ok: false,
    error: 'Not sure what you mean — "time" if you\'re chasing a goal time, "finish" if you just want to cross the line.',
  };
}

// Parses HH:MM:SS, H:MM:SS, or MM:SS into total seconds.
export function parseTargetTime(text: string): ParseResult<number> {
  const v = text.trim();
  const parts = v.split(":").map((p) => p.trim());

  let totalSeconds: number;

  if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const s = Number(parts[2]);
    if ([h, m, s].some((n) => isNaN(n)) || m >= 60 || s >= 60)
      return { ok: false, error: "Format as H:MM:SS — e.g. 3:45:00." };
    totalSeconds = h * 3600 + m * 60 + s;
  } else if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if ([m, s].some((n) => isNaN(n)) || s >= 60)
      return { ok: false, error: "Format as H:MM:SS — e.g. 3:45:00." };
    totalSeconds = m * 60 + s;
  } else {
    return { ok: false, error: "Format as H:MM:SS — e.g. 3:45:00." };
  }

  if (totalSeconds < 600)
    return {
      ok: false,
      error: "That time seems too fast — double-check and try again.",
    };
  if (totalSeconds > 86400)
    return {
      ok: false,
      error: "That time seems too slow — anything under 24 hours is fine.",
    };

  return { ok: true, value: totalSeconds };
}

function parseMeaning(text: string): ParseResult<string> {
  const v = text.trim();
  if (v.length === 0) return { ok: false, error: "Send at least a word or two." };
  if (v.length > 500)
    return { ok: false, error: "Keep it under 500 characters." };
  return { ok: true, value: v };
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

const distanceQuestion: Question<Distance> = {
  key: "distance",
  prompt: "What's your goal distance? (5k / 10k / half / marathon / ultra)",
  parseReply(text) {
    return parseDistance(text);
  },
};

const targetQuestion: Question<Target> = {
  key: "target",
  prompt: "Are you training for a specific time goal, or just to finish?",
  parseReply(text) {
    return parseTarget(text);
  },
};

const targetTimeQuestion: Question<number> = {
  key: "target_time",
  prompt: "What's your target time? (e.g. 3:45:00 for a marathon)",
  skip: (partial) => partial.target !== "time",
  parseReply(text) {
    return parseTargetTime(text);
  },
};

const meaningQuestion: Question<string> = {
  key: "meaning",
  prompt: "In a sentence or two — what does this race mean to you?",
  parseReply(text) {
    return parseMeaning(text);
  },
};

// ---------------------------------------------------------------------------
// Step definition
// ---------------------------------------------------------------------------

function formatTargetTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const DISTANCE_LABELS: Record<Distance, string> = {
  "5k": "5K",
  "10k": "10K",
  half: "Half Marathon",
  marathon: "Marathon",
  ultra: "Ultramarathon",
};

export const goalsStep: OnboardingStep = {
  id: "goals",
  questions: [distanceQuestion, targetQuestion, targetTimeQuestion, meaningQuestion],
  async onComplete(athleteId, partial) {
    const distance = partial.distance as Distance;
    const target = partial.target as Target;
    const targetTime = partial.target_time as number | undefined;
    const meaning = partial.meaning as string;

    const noteParts = [
      `Goal distance: ${DISTANCE_LABELS[distance]}`,
      `Target: ${target === "time" ? "Finish in a goal time" : "Just finish"}`,
    ];
    if (target === "time" && targetTime !== undefined) {
      noteParts.push(`Target time: ${formatTargetTime(targetTime)}`);
    }
    noteParts.push(`What this race means: ${meaning}`);

    const notes = noteParts.join("\n");

    const { error } = await supabaseAdmin()
      .from("athletes")
      .update({ notes, updated_at: new Date().toISOString() })
      .eq("id", athleteId);

    if (error) throw new Error(`goals onComplete DB update failed: ${error.message}`);

    const goalLines = [
      `Distance: ${DISTANCE_LABELS[distance]}`,
      `Goal type: ${target === "time" ? "Time goal" : "Finish"}`,
    ];
    if (target === "time" && targetTime !== undefined) {
      goalLines.push(`Target time: ${formatTargetTime(targetTime)}`);
    }
    goalLines.push(`Meaning: ${meaning}`);

    await upsertProfileSection(athleteId, "Goals", goalLines.join("\n"));
  },
};
