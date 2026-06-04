// Onboarding v3 (V3-W1): the slot-value primitive every slot is filled with.
//
// Generalizes the `Provenance` + `Field` pattern that v2's enrichment step
// (steps/05-enrichment.ts) uses for the freeform dump, lifting it out so the
// whole v3 intake — not just the final dump — carries provenance on every fact.
//
// The one addition over v2's `Field` is `confirmed`. v3 makes "an inferred value
// is never written to a safety or plan-driving slot without a confirm turn"
// (ONBOARDING_V3 §5.4) a code-enforced invariant; the guardrails (W2) read this
// bit to decide whether a fill may be committed. v2's `Field` had no place to
// record that an inline-confirm turn had happened, so reusing it verbatim would
// under-build.

import { z } from 'zod';

export type Provenance = 'stated' | 'inferred' | 'unknown';

export const ProvenanceSchema = z.enum(['stated', 'inferred', 'unknown']);

/** A single slot fill: the value, where it came from, and whether an
 *  inline-confirm turn has happened for it. */
export interface SlotValue<T> {
  value: T | null;
  provenance: Provenance;
  confirmed: boolean;
}

/** Zod schema for a `SlotValue<T>` given the schema for its inner value. W2's
 *  `extract_and_advance` tool validates fills against this. */
export function slotValueSchema<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value: value.nullable(),
    provenance: ProvenanceSchema,
    confirmed: z.boolean(),
  });
}

/** An unfilled slot — null value, `unknown` provenance, unconfirmed. The
 *  resting state every slot starts in. */
export function unknownSlot<T>(): SlotValue<T> {
  return { value: null, provenance: 'unknown', confirmed: false };
}

/** Construct a slot value. Convenience for code that fills slots directly
 *  (the Strava-derived seed, the race-lookup result, the numeric backstop). */
export function slotValue<T>(
  value: T | null,
  provenance: Provenance,
  confirmed: boolean,
): SlotValue<T> {
  return { value, provenance, confirmed };
}

/** True when a slot carries a real, known value (excludes the `unknown`
 *  resting state). Safety slots use a looser check (a skip writes a non-null
 *  `unknown`-provenance value that still counts as answered) — see
 *  slot-state.ts `isV3OnboardingComplete`. */
export function isFilled(slot: SlotValue<unknown> | undefined): boolean {
  return !!slot && slot.value != null && slot.provenance !== 'unknown';
}
