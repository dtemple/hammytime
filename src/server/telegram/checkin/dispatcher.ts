import type { Context } from "grammy";
import { supabaseAdmin } from "@/lib/db";
import type { Database } from "@/lib/db-types";
import { sendAndLog } from "../bot";
import { appendWellnessRow } from "./wellness-log";
import {
  READINESS_PROMPT,
  SORENESS_PROMPT,
  NOTE_PROMPT,
  CONCERNING_LINE,
  parseReadiness,
  parseSoreness,
  parseNote,
  isConcerning,
} from "./wellness";
import type { WellnessState, WellnessEntry } from "./types";

type AthleteRow = Database["public"]["Tables"]["athletes"]["Row"];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function logInbound(athleteId: string, body: string): Promise<void> {
  await supabaseAdmin().from("messages").insert({
    athlete_id: athleteId,
    channel: "tg",
    direction: "in",
    body,
  });
}

async function writeCheckinState(
  athleteId: string,
  state: WellnessState | Record<string, never>
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("athletes")
    .update({ checkin_state: state, updated_at: new Date().toISOString() })
    .eq("id", athleteId);
  if (error) throw new Error(`writeCheckinState failed: ${error.message}`);
}

/**
 * Returns the current date and time in the athlete's timezone.
 * Falls back to America/Los_Angeles if the timezone is null or invalid.
 */
function nowInTimezone(tz: string | null): { date: string; time: string } {
  const timezone = tz ?? "America/Los_Angeles";
  const now = new Date();

  // en-CA gives YYYY-MM-DD format reliably.
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const date = dateParts
    .filter((p) => p.type !== "literal")
    .map((p) => p.value)
    .join("-");

  // en-GB with hour12: false gives HH:MM reliably.
  const timeParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const time = timeParts
    .filter((p) => p.type !== "literal")
    .map((p) => p.value)
    .join(":");

  return { date, time };
}

async function onWellnessComplete(
  chatId: number | string,
  athlete: AthleteRow,
  entry: WellnessEntry
): Promise<void> {
  await appendWellnessRow(athlete.id, entry);
  await writeCheckinState(athlete.id, {});

  const bodyPartSuffix = entry.body_part !== "—" ? ` (${entry.body_part})` : "";
  const notePart = entry.note !== "—" ? entry.note : "no note";
  // REPLACE-IN-PROMPT-16: swap placeholder for real coaching response trigger
  const ack = `Logged. Readiness ${entry.readiness}, soreness ${entry.soreness}${bodyPartSuffix}, ${notePart}. Coaching response will fire in the next prompt's work.`;
  await sendAndLog(athlete.id, chatId, ack);

  if (isConcerning(entry.readiness, entry.soreness, entry.body_part !== "—" ? entry.body_part : null)) {
    await sendAndLog(athlete.id, chatId, CONCERNING_LINE);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handles the /checkin command for a post-onboarding athlete.
 *
 * Guards:
 * - If a check-in is already in progress, replies with the re-entry refusal.
 * - Otherwise starts the wellness battery at awaiting_readiness.
 *
 * Caller is responsible for verifying onboarding is complete before calling.
 */
export async function handleCheckinCommand(
  ctx: Context,
  athlete: AthleteRow
): Promise<void> {
  const chatId = ctx.chat!.id;
  const cs = athlete.checkin_state as Record<string, unknown> | null;

  if (cs?.sub_step) {
    await ctx.reply(
      "Already mid-check-in. Answer the previous question or /cancel to reset."
    );
    return;
  }

  await writeCheckinState(athlete.id, {
    sub_step: "awaiting_readiness",
    partial: {},
  });
  await sendAndLog(athlete.id, chatId, READINESS_PROMPT);
}

/**
 * Routes an inbound text message through the wellness battery state machine.
 * Called by handleInboundText when checkin_state.sub_step is set.
 */
export async function handleWellnessMessage(
  ctx: Context,
  athlete: AthleteRow
): Promise<void> {
  const chatId = ctx.chat!.id;
  const text = ctx.message?.text ?? "";

  await logInbound(athlete.id, text);

  const cs = athlete.checkin_state as WellnessState | null;
  const subStep = cs?.sub_step;
  const partial = cs?.partial ?? {};

  switch (subStep) {
    case "awaiting_readiness": {
      const result = parseReadiness(text);
      if (!result.ok) {
        await sendAndLog(athlete.id, chatId, `${result.error}\n\n${READINESS_PROMPT}`);
        return;
      }
      await writeCheckinState(athlete.id, {
        sub_step: "awaiting_soreness",
        partial: { ...partial, readiness: result.value },
      });
      await sendAndLog(athlete.id, chatId, SORENESS_PROMPT);
      return;
    }

    case "awaiting_soreness": {
      const result = parseSoreness(text);
      if (!result.ok) {
        await sendAndLog(athlete.id, chatId, `${result.error}\n\n${SORENESS_PROMPT}`);
        return;
      }
      await writeCheckinState(athlete.id, {
        sub_step: "awaiting_note",
        partial: {
          ...partial,
          soreness_score: result.value.score,
          soreness_body_part: result.value.body_part,
        },
      });
      await sendAndLog(athlete.id, chatId, NOTE_PROMPT);
      return;
    }

    case "awaiting_note": {
      const result = parseNote(text);
      // parseNote always succeeds.
      const noteValue = result.ok ? result.value : null;
      const { date, time } = nowInTimezone(athlete.timezone);

      const entry: WellnessEntry = {
        date,
        time,
        readiness: partial.readiness ?? 0,
        soreness: partial.soreness_score ?? 0,
        body_part: partial.soreness_body_part ?? "—",
        note: noteValue ?? "—",
      };

      await onWellnessComplete(chatId, athlete, entry);
      return;
    }

    default:
      // sub_step is missing or unrecognized — reset state silently.
      await writeCheckinState(athlete.id, {});
      return;
  }
}
