export type WellnessSubStep =
  | "awaiting_readiness"
  | "awaiting_soreness"
  | "awaiting_note";

export type WellnessPartial = {
  readiness?: number;
  soreness_score?: number;
  soreness_body_part?: string | null;
  note?: string | null;
};

export type WellnessState = {
  sub_step: WellnessSubStep;
  partial: WellnessPartial;
};

// Shape written to wellness_log.md. Column names match the personal coach format.
export type WellnessEntry = {
  date: string; // YYYY-MM-DD, athlete-local
  time: string; // HH:MM 24h, athlete-local
  readiness: number;
  soreness: number;
  body_part: string; // raw text or "—"
  note: string; // free text or "—"
};
