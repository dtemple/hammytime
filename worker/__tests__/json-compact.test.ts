import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { compactJson } from '../json-compact';
import { PlanSchema } from '@/lib/plan-schema';

const seedPlan = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../seeds/marathon_training_plan.json', import.meta.url)), 'utf8'),
);

describe('compactJson', () => {
  it('round-trips: parsing the output deep-equals the input', () => {
    expect(JSON.parse(compactJson(seedPlan))).toEqual(seedPlan);
  });

  it('round-trips a range of plain JSON values', () => {
    const cases: unknown[] = [
      null,
      42,
      'a string',
      true,
      [],
      {},
      [1, 2, 3],
      { a: 1, b: [true, false, null], c: { d: 'x' } },
      { nested: { deep: { array: [{ x: 1 }, { y: 2 }] } } },
    ];
    for (const c of cases) expect(JSON.parse(compactJson(c))).toEqual(c);
  });

  it('omits undefined object values and nulls undefined array positions, like JSON.stringify', () => {
    const out = compactJson({ a: undefined, b: 1, c: [undefined, 2] });
    expect(JSON.parse(out)).toEqual({ b: 1, c: [null, 2] });
  });

  it('collapses every day object onto a single line', () => {
    const out = compactJson(seedPlan);
    for (const week of seedPlan.weeks) {
      for (const day of week.days) {
        expect(out).toContain(JSON.stringify(day));
      }
    }
  });

  it('keeps the weeks array multi-line (weeks are not collapsed)', () => {
    const out = compactJson(seedPlan);
    // Each week is far larger than maxLength, so it must expand. A collapsed
    // weeks array would render the whole array on one "weeks": [...] line.
    expect(out).toMatch(/"weeks": \[\n/);
    // A day line should be indented under its week, not on the weeks line.
    expect(out).not.toMatch(/"weeks": \[\{/);
  });

  it('is meaningfully smaller than 2-space pretty-print', () => {
    const compact = compactJson(seedPlan).length;
    const pretty = JSON.stringify(seedPlan, null, 2).length;
    expect(compact).toBeLessThan(pretty * 0.75); // at least 25% smaller
  });

  it('output still validates against PlanSchema after a parse round-trip', () => {
    const parsed = JSON.parse(compactJson(seedPlan));
    expect(PlanSchema.safeParse(parsed).success).toBe(true);
  });
});
