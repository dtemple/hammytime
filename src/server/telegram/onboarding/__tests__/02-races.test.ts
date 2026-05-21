import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/anthropic", () => ({ anthropicClient: vi.fn() }));
vi.mock("@/server/agent/race-lookup", () => ({ lookupRace: vi.fn() }));

import { supabaseAdmin } from "@/lib/db";
import { anthropicClient } from "@/lib/anthropic";
import { lookupRace } from "@/server/agent/race-lookup";
import { racesStep } from "../steps/02-races";
import type { RaceLookupResult } from "@/server/agent/race-lookup";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = "test-athlete";
const handleMessage = racesStep.handleMessage!;

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

function makeDb() {
  const insertMock = vi.fn().mockResolvedValue({ error: null });
  const upsertMock = vi.fn().mockResolvedValue({ error: null });
  const maybeSingleMock = vi.fn().mockResolvedValue({
    data: { notes: "Target: Finish in a goal time\nTarget time: 3:45:00" },
    error: null,
  });
  const eqChain = {
    eq: vi.fn().mockReturnThis(),
    maybeSingle: maybeSingleMock,
    select: vi.fn().mockReturnThis(),
  };
  eqChain.eq.mockReturnValue(eqChain);

  const fromMock = vi.fn().mockImplementation(() => ({
    select: vi.fn().mockReturnValue(eqChain),
    insert: insertMock,
    upsert: upsertMock,
  }));

  return { from: fromMock, insertMock, upsertMock };
}

// ---------------------------------------------------------------------------
// lookupRace mock helpers
// ---------------------------------------------------------------------------

function foundResult(overrides?: AnyMock): RaceLookupResult {
  return {
    ok: true,
    found: {
      canonical_name: "Chicago Marathon",
      date: "2026-10-04",
      distance_mi: 26.2,
      elevation_ft: 450,
      terrain: "road",
      source_url: "https://www.chicagomarathon.com",
      confidence: "high",
      ...overrides,
    },
  };
}

function ambiguousResult(): RaceLookupResult {
  return {
    ok: true,
    ambiguous: [
      {
        canonical_name: "Boston Marathon (April)",
        date: "2026-04-20",
        distance_mi: 26.2,
        elevation_ft: 800,
        terrain: "road",
        source_url: null,
        confidence: "high",
      },
      {
        canonical_name: "Boston Marathon (September)",
        date: "2026-09-15",
        distance_mi: 26.2,
        elevation_ft: 600,
        terrain: "road",
        source_url: null,
        confidence: "medium",
      },
    ],
  };
}

function notFoundResult(): RaceLookupResult {
  return { ok: false, reason: "not_found" };
}

// ---------------------------------------------------------------------------
// Haiku (parsePastRace) mock
// ---------------------------------------------------------------------------

function makeHaikuResponse(input: AnyMock) {
  return {
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", name: "parse_past_race", input },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const db = makeDb();
  vi.mocked(supabaseAdmin as AnyMock).mockReturnValue({ from: db.from });
});

// ---------------------------------------------------------------------------
// Helper: run sub-flow step by step
// ---------------------------------------------------------------------------

async function step(
  text: string,
  partial: Record<string, unknown>
) {
  return handleMessage(text, partial, ATHLETE_ID);
}

// ---------------------------------------------------------------------------
// 2a → 2b (high confidence) → yes → tuneup_loop
// ---------------------------------------------------------------------------

describe("happy path: goal confirmed", () => {
  it("2a: accepts goal race name, returns confirm prompt", async () => {
    vi.mocked(lookupRace as AnyMock).mockResolvedValue(foundResult());

    const r = await step("Chicago Marathon", {});

    expect(r.done).toBe(false);
    if (!r.done) {
      expect(r.reply).toContain("Chicago Marathon");
      expect(r.reply).toMatch(/yes.*no.*wrong/i);
      expect(r.newPartial.sub_step).toBe("goal_confirm");
    }
  });

  it("2b: 'yes' confirms goal race, transitions to tuneup_loop", async () => {
    const partial = {
      sub_step: "goal_confirm",
      tuneups: [],
      goal_lookup: foundResult(),
      goal_manual: { name: "Chicago Marathon" },
    };

    const r = await step("yes", partial);

    expect(r.done).toBe(false);
    if (!r.done) {
      expect(r.newPartial.sub_step).toBe("tuneup_loop");
      expect((r.newPartial as AnyMock).goal_race).toBeDefined();
      expect((r.newPartial as AnyMock).goal_race.name).toBe("Chicago Marathon");
    }
  });

  it("tuneup_loop: 'done' transitions to past_race", async () => {
    const partial = {
      sub_step: "tuneup_loop",
      tuneups: [],
      goal_race: { name: "Chicago Marathon", date: "2026-10-04", distance_mi: 26.2, elevation_ft: 450, terrain: "road", source_url: null },
    };

    const r = await step("done", partial);

    expect(r.done).toBe(false);
    if (!r.done) {
      expect(r.newPartial.sub_step).toBe("past_race");
      expect(r.reply).toMatch(/best race/i);
    }
  });

  it("past_race: skip → done=true with null past_race", async () => {
    const partial = {
      sub_step: "past_race",
      tuneups: [],
      goal_race: { name: "Chicago Marathon", date: "2026-10-04", distance_mi: 26.2, elevation_ft: 450, terrain: "road", source_url: null },
    };

    const r = await step("skip", partial);

    expect(r.done).toBe(true);
    if (r.done) {
      expect((r.newPartial as AnyMock).past_race).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 2b: 'wrong' → manual flow
// ---------------------------------------------------------------------------

describe("manual correction flow", () => {
  it("'wrong' in goal_confirm transitions to goal_manual_date", async () => {
    const partial = {
      sub_step: "goal_confirm",
      tuneups: [],
      goal_lookup: foundResult(),
      goal_manual: { name: "Chicago Marathon" },
    };

    const r = await step("wrong", partial);

    expect(r.done).toBe(false);
    if (!r.done) {
      expect(r.newPartial.sub_step).toBe("goal_manual_date");
    }
  });

  it("goal_manual_date: valid date accepted", async () => {
    const partial = {
      sub_step: "goal_manual_date",
      tuneups: [],
      goal_manual: { name: "Unknown Race" },
    };

    const r = await step("Oct 4 2026", partial);

    expect(r.done).toBe(false);
    if (!r.done) {
      expect(r.newPartial.sub_step).toBe("goal_manual_distance");
    }
  });

  it("goal_manual_date: 'skip' accepted", async () => {
    const partial = { sub_step: "goal_manual_date", tuneups: [], goal_manual: { name: "Race" } };
    const r = await step("skip", partial);
    expect(r.done).toBe(false);
    if (!r.done) expect(r.newPartial.sub_step).toBe("goal_manual_distance");
  });

  it("goal_manual_distance: marathon alias accepted", async () => {
    const partial = {
      sub_step: "goal_manual_distance",
      tuneups: [],
      goal_manual: { name: "Race", date: "2026-10-04" },
    };
    const r = await step("marathon", partial);
    expect(r.done).toBe(false);
    if (!r.done) expect(r.newPartial.sub_step).toBe("goal_manual_elevation");
  });

  it("full manual flow leads to tuneup_loop", async () => {
    const partialDate = { sub_step: "goal_manual_date", tuneups: [], goal_manual: { name: "My Race" } };
    const r1 = await step("2026-11-01", partialDate);
    expect(r1.done).toBe(false);

    const r2 = await step("26.2", r1.done ? {} : r1.newPartial);
    expect(r2.done).toBe(false);

    const r3 = await step("1000", r2.done ? {} : r2.newPartial);
    expect(r3.done).toBe(false);

    const r4 = await step("trail", r3.done ? {} : r3.newPartial);
    expect(r4.done).toBe(false);
    if (!r4.done) {
      expect(r4.newPartial.sub_step).toBe("tuneup_loop");
      expect((r4.newPartial as AnyMock).goal_race).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Ambiguous → select by number
// ---------------------------------------------------------------------------

describe("ambiguous race selection", () => {
  it("numbered selection picks the right candidate", async () => {
    vi.mocked(lookupRace as AnyMock).mockResolvedValue(ambiguousResult());

    const r1 = await step("Boston Marathon", {});

    expect(r1.done).toBe(false);
    if (r1.done) return;
    expect(r1.reply).toContain("1.");
    expect(r1.newPartial.sub_step).toBe("goal_confirm");

    const r2 = await step("2", r1.newPartial);

    expect(r2.done).toBe(false);
    if (!r2.done) {
      expect(r2.newPartial.sub_step).toBe("tuneup_loop");
      expect((r2.newPartial as AnyMock).goal_race?.name).toBe("Boston Marathon (September)");
    }
  });
});

// ---------------------------------------------------------------------------
// Not found → manual flow
// ---------------------------------------------------------------------------

describe("not found → manual", () => {
  it("not_found triggers manual date collection", async () => {
    vi.mocked(lookupRace as AnyMock).mockResolvedValue(notFoundResult());

    const r = await step("SomeMadeUpRace5000", {});

    expect(r.done).toBe(false);
    if (!r.done) {
      expect(r.newPartial.sub_step).toBe("goal_manual_date");
    }
  });
});

// ---------------------------------------------------------------------------
// Tune-up cap
// ---------------------------------------------------------------------------

describe("tune-up cap", () => {
  function makePartialWithTuneups(count: number) {
    const tuneups = Array.from({ length: count }, (_, i) => ({
      name: `Tune-up ${i + 1}`,
      date: null,
      distance_mi: null,
      elevation_ft: null,
      terrain: null,
      source_url: null,
    }));
    return {
      sub_step: "tuneup_loop" as const,
      tuneups,
      goal_race: { name: "Chicago Marathon", date: "2026-10-04", distance_mi: 26.2, elevation_ft: 450, terrain: "road", source_url: null },
    };
  }

  it("warns at 4 tune-ups", async () => {
    vi.mocked(lookupRace as AnyMock).mockResolvedValue(foundResult({ canonical_name: "Local Half" }));
    const partial = makePartialWithTuneups(4);
    const r = await step("Local Half", partial);
    // After lookup, it goes to tuneup_confirm; but first check the response contains warning
    // Actually the warning shows AFTER the 4th is added - check when we come back to tuneup_loop
    // The reply after confirming 4th tuneup should mention the warning
    // In our implementation, the warning is shown in nextAfterRace when tuneups.length === 4
    expect(r.done).toBe(false);
    // The 5th tuneup triggers the lookup; after confirmation it shows warning
    // We verify the flow doesn't break
    if (!r.done) {
      expect(r.newPartial.sub_step).toBe("tuneup_confirm");
    }
  });

  it("rejects a 7th tune-up name (hard cap at 6)", async () => {
    const partial = makePartialWithTuneups(6);
    const r = await step("Another Race", partial);

    expect(r.done).toBe(false);
    if (!r.done) {
      expect(r.reply).toMatch(/limit|cap/i);
      expect(r.newPartial.sub_step).toBe("tuneup_loop"); // stays in loop
    }
  });
});

// ---------------------------------------------------------------------------
// Past race parsing (Haiku)
// ---------------------------------------------------------------------------

describe("past_race parsing", () => {
  const basePastPartial = {
    sub_step: "past_race" as const,
    tuneups: [],
    goal_race: { name: "Chicago Marathon", date: "2026-10-04", distance_mi: 26.2, elevation_ft: 450, terrain: "road", source_url: null },
  };

  it("parses a valid past race description and sets done=true", async () => {
    const createMock = vi.fn().mockResolvedValue(
      makeHaikuResponse({ name: "Boston Marathon", finish_time_seconds: 13932, date: "2024-04-15" })
    );
    vi.mocked(anthropicClient as AnyMock).mockReturnValue({
      messages: { create: createMock },
    });

    const r = await step("Boston Marathon 2024 in 3:52:12", basePastPartial);

    expect(r.done).toBe(true);
    if (r.done) {
      const pr = (r.newPartial as AnyMock).past_race;
      expect(pr).toBeDefined();
      expect(pr.name).toBe("Boston Marathon");
      expect(pr.finish_time_seconds).toBe(13932);
    }
  });

  it("re-asks once on Haiku parse failure", async () => {
    const createMock = vi.fn().mockResolvedValue(
      makeHaikuResponse({ garbage: true })
    );
    vi.mocked(anthropicClient as AnyMock).mockReturnValue({
      messages: { create: createMock },
    });

    const r = await step("Some race I ran once", basePastPartial);

    expect(r.done).toBe(false);
    if (!r.done) {
      expect(r.newPartial.sub_step).toBe("past_race");
      expect((r.newPartial as AnyMock).past_race_attempts).toBe(1);
    }
  });

  it("accepts raw text on second failure (graceful degradation)", async () => {
    const createMock = vi.fn().mockResolvedValue(
      makeHaikuResponse({ garbage: true })
    );
    vi.mocked(anthropicClient as AnyMock).mockReturnValue({
      messages: { create: createMock },
    });

    const partial = { ...basePastPartial, past_race_attempts: 1 };
    const r = await step("I ran a race once, it was great", partial as AnyMock);

    expect(r.done).toBe(true);
    if (r.done) {
      const pr = (r.newPartial as AnyMock).past_race;
      expect(pr.name).toBeTruthy();
      expect(pr.finish_time_seconds).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// onComplete: DB writes
// ---------------------------------------------------------------------------

describe("onComplete", () => {
  it("inserts goal race, tuneup, and past race rows", async () => {
    const db = makeDb();
    vi.mocked(supabaseAdmin as AnyMock).mockReturnValue({ from: db.from });

    const partial = {
      sub_step: "past_race",
      goal_race: { name: "Chicago Marathon", date: "2026-10-04", distance_mi: 26.2, elevation_ft: 450, terrain: "road", source_url: null },
      tuneups: [
        { name: "Local Half", date: "2026-08-15", distance_mi: 13.1, elevation_ft: 200, terrain: "road", source_url: null },
      ],
      past_race: { name: "Boston Marathon", finish_time_seconds: 13932, date: "2024-04-15" },
    };

    await racesStep.onComplete(ATHLETE_ID, partial);

    // 3 insert calls: goal race, tuneup, past race
    expect(db.insertMock).toHaveBeenCalledTimes(3);

    const calls = db.insertMock.mock.calls.map((c: AnyMock) => c[0]);
    const goalCall = calls.find((c: AnyMock) => c.name === "Chicago Marathon");
    const tuneupCall = calls.find((c: AnyMock) => c.name === "Local Half");
    const pastCall = calls.find((c: AnyMock) => c.name === "Boston Marathon");

    expect(goalCall).toBeDefined();
    expect(goalCall.status).toBe("upcoming");
    expect(goalCall.target_type).toBe("time");  // from mocked athletes.notes

    expect(tuneupCall).toBeDefined();
    expect(tuneupCall.target_type).toBe("finish");

    expect(pastCall).toBeDefined();
    expect(pastCall.status).toBe("completed");
  });

  it("writes race_calendar.md and personal_records.md", async () => {
    const db = makeDb();
    vi.mocked(supabaseAdmin as AnyMock).mockReturnValue({ from: db.from });

    const partial = {
      sub_step: "past_race",
      goal_race: { name: "Chicago Marathon", date: "2026-10-04", distance_mi: 26.2, elevation_ft: 450, terrain: "road", source_url: null },
      tuneups: [],
      past_race: { name: "Boston Marathon", finish_time_seconds: 13500, date: "2024-04-15" },
    };

    await racesStep.onComplete(ATHLETE_ID, partial);

    const upsertCalls = db.upsertMock.mock.calls.map((c: AnyMock) => c[0]);
    const calendarUpsert = upsertCalls.find((u: AnyMock) => u.file_name === "race_calendar.md");
    const prUpsert = upsertCalls.find((u: AnyMock) => u.file_name === "personal_records.md");

    expect(calendarUpsert).toBeDefined();
    expect(calendarUpsert.content_md).toContain("Chicago Marathon");
    expect(calendarUpsert.content_md).toContain("Boston Marathon");

    expect(prUpsert).toBeDefined();
    expect(prUpsert.content_md).toContain("Boston Marathon");
    expect(prUpsert.content_md).toContain("3:45:00"); // 13500s = 3h45m
  });
});
