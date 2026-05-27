export const BODY_PARTS = [
  'hamstring',
  'knee',
  'calf',
  'achilles',
  'hip',
  'back',
  'ankle',
  'plantar',
  'it_band',
  'other',
] as const;

export type BodyPart = (typeof BODY_PARTS)[number];

// bilateral = parts where laterality is a meaningful question
export const BILATERAL_PARTS: ReadonlySet<BodyPart> = new Set([
  'hamstring',
  'knee',
  'calf',
  'achilles',
  'hip',
  'ankle',
  'plantar',
  'it_band',
]);

export const BODY_PART_LABELS: Record<BodyPart, string> = {
  hamstring: 'Hamstring',
  knee: 'Knee',
  calf: 'Calf',
  achilles: 'Achilles',
  hip: 'Hip',
  back: 'Back',
  ankle: 'Ankle',
  plantar: 'Plantar fascia',
  it_band: 'IT band',
  other: 'Other',
};
