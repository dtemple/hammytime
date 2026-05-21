import { supabaseAdmin } from "@/lib/db";
import { upsertProfileSection } from "../memory";
import type { OnboardingStep, ParseResult, Question } from "../types";

const anythingElseQuestion: Question<string | null> = {
  key: "anything_else",
  prompt:
    "Anything else I should know? Asthma, schedule constraints, gear notes, prior coaching, anything that feels off — or `skip`.",
  parseReply(text) {
    const trimmed = text.trim();
    if (
      trimmed.toLowerCase() === "skip" ||
      trimmed.toLowerCase() === "none" ||
      trimmed === ""
    ) {
      return { ok: true, value: null };
    }
    return { ok: true, value: trimmed.slice(0, 2000) };
  },
};

export const anythingElseStep: OnboardingStep = {
  id: "anything_else",
  questions: [anythingElseQuestion as Question],
  async onComplete(athleteId, partial) {
    const text = partial.anything_else as string | null;
    const body = text ?? "_None reported._";

    await upsertProfileSection(athleteId, "Anything else", body);

    // heuristic — substring match, v1 only
    const flagAsthma = /asthma|inhaler|albuterol/i.test(text ?? "");
    if (flagAsthma) {
      const { error } = await supabaseAdmin()
        .from("athletes")
        .update({ asthma: true, updated_at: new Date().toISOString() })
        .eq("id", athleteId);
      if (error) throw new Error(`anythingElse asthma update failed: ${error.message}`);
    }
  },
};
