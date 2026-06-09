// A compact reference for the shape of a day object in marathon_training_plan.json,
// shared by the coach prompt (worker/system-prompt.ts) and the repair pass
// (worker/plan-repair.ts). The day-type list is built from DayTypeEnum so it can't
// drift; the tuple-field guidance is hand-written and guarded by a test
// (src/lib/plan-schema.test.ts) against DaySchema.
//
// This is the data model the coach keeps getting wrong: an out-of-list `type`,
// and the range fields written as a single number instead of a [min, max] pair.

import { DayTypeEnum } from './plan-schema';

// Day-level fields the schema requires as a [min, max] tuple — written as a bare
// number, validation drops the whole edit. Exported for the drift-guard test.
export const TUPLE_RANGE_FIELDS = [
  'target_hr_zone',
  'target_rpe',
  'target_pace_sec_per_mile',
  'target_hill_grade_percent',
  'uphill_hr_zone',
  'uphill_rpe',
] as const;

const TYPE_LIST = DayTypeEnum.options.map((t) => `\`${t}\``).join(', ');

const RANGE_LIST = TUPLE_RANGE_FIELDS.map((f) => `\`${f}\``).join(', ');

export const PLAN_SHAPE_REFERENCE = `A day object validates against a strict schema. Two shapes are easy to get wrong, and either one drops the whole edit:

- **\`type\` must be exactly one of:** ${TYPE_LIST}. No other value validates — don't invent a type (no \`recovery\`, no \`cross_train\`); pick the closest one from this list (a recovery jog is \`easy\`).
- **Range fields are a \`[min, max]\` pair, never a single number.** This is \`strides.count\` (e.g. \`[6, 8]\`) and ${RANGE_LIST} (e.g. \`target_pace_sec_per_mile: [480, 510]\`). Writing \`"count": 8\` instead of \`"count": [8, 8]\` fails validation.

\`strides\` only belongs on an \`easy_with_strides\` day, and its shape is \`{ "count": [min, max], "duration_sec": <int>, "recovery": "<text>" }\`.

The safe way to edit a day is to copy an existing day line that already has the fields you need and change its values — not to compose a day object from memory.`;
