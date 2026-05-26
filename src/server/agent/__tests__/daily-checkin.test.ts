import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that use them
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/anthropic", () => ({ anthropicClient: vi.fn() }));
vi.mock("@/server/strava/activities", () => ({
  fetchRecentActivities: vi.fn(),
  StravaTokenBrokenError: class StravaTokenBrokenError extends Error {
    constructor(cause?: unknown) {
      super("Strava token refresh failed or was revoked");
      this.name = "StravaTokenBrokenError";
      if (cause instanceof Error) this.cause = cause;
    }
  },
}));

// byo-plan loadAthleteData is imported inside daily-checkin.ts.
// We mock it at the module level so tests control the return value.
vi.mock("../byo-plan", () => ({ loadAthleteData: vi.fn() }));

// fs.readFileSync — stub the system prompt so tests don't need the real file.
vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue("You are a coach. No tools."),
}));

import { supabaseAdmin } from "@/lib/db";
import { anthropicClient } from "@/lib/anthropic";
import { fetchRecentActivities, StravaTokenBrokenError } from "@/server/strava/activities";
import { loadAthleteData } from "../byo-plan";
import { runDailyCheckin, appendCheckinEntry, buildUserMessage } from "../daily-checkin";
import type { StravaActivitySummary } from "@/server/strava/activities";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = "athlete-abc";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ATHLETE_DATA = {
  athlete: {
    id: ATHLETE_ID,
    name: "Dave",
    dob: "1981-01-01",
    sex: "M",
    timezone: "America/Los_Angeles",
    notes: null,
    asthma: false,
    telegram_chat_id: "12345",
  },
  goalRace: null,
  tuneupRaces: [],
  pastRace: null,
  injuries: [],
  profileMd: "## Schedule\nTraining days per week: 5",
};

const TWO_ACTIVITIES: StravaActivitySummary[] = [
  {
    id: 1,
    name: "Morning Run",
    type: "Run",
    start_date_local: "2026-05-24T07:30:00",
    distance_m: 8046,
    moving_time_s: 2880,
    elapsed_time_s: 3000,
    total_elevation_gain_m: 45,
    average_heartrate: 142,
    max_heartrate: 158,
    average_speed_mps: 2.79,
  },
  {
    id: 2,
    name: "Trail Run",
    type: "TrailRun",
    start_date_local: "2026-05-26T06:15:00",
    distance_m: 16093,
    moving_time_s: 7200,
    elapsed_time_s: 7500,
    total_elevation_gain_m: 610,
    average_heartrate: 148,
    max_heartrate: 172,
    average_speed_mps: 2.24,
  },
];

const WELLNESS = {
  readiness: 7,
  soreness_score: 3,
  soreness_body_part: null,
  note: "Slept well",
};

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

/**
 * Builds a chainable Supabase mock that:
 * - memory_files: returns the provided content for given file names
 * - plans: returns a plan row
 * - plan_versions: returns a plan_versions row
 * - agent_runs: insert succeeds
 */
function makeDb(opts: {
  injuryLogMd?: string;
  checkinLogMd?: string;
  planStartDate?: string;
  planJson?: unknown;
} = {}) {
  const {
    injuryLogMd = "",
    checkinLogMd = "",
    planStartDate = "2026-04-01",
    planJson = { weeks: [{ week_number: 1, phase: "base", days: [{ day: "Monday", type: "easy", description: "Easy run", planned_distance_miles: 6 }] }] },
  } = opts;

  const insertMock = vi.fn().mockResolvedValue({ error: null });
  const updateMock = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    }),
  });

  // memory_files query chains: .select().eq().eq().maybeSingle()
  let memoryFileCallCount = 0;
  const memoryEqChain = {
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockImplementation(() => {
      // First call = injury_log.md, second = checkin_log.md
      // (parallel via Promise.all in loadAthleteData is handled in byo-plan mock;
      //  these are the two extra calls in loadMemoryFile)
      memoryFileCallCount++;
      const content =
        memoryFileCallCount === 1 ? injuryLogMd : checkinLogMd;
      return Promise.resolve({ data: content ? { content_md: content } : null, error: null });
    }),
  };
  memoryEqChain.eq.mockReturnValue(memoryEqChain);

  // plans query chain: .select().eq().maybeSingle()
  const plansEqChain = {
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: { id: "plan-1", start_date: planStartDate },
      error: null,
    }),
  };
  plansEqChain.eq.mockReturnValue(plansEqChain);

  // plan_versions query chain: .select().eq().eq().maybeSingle()
  const pvEqChain = {
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: { plan_json: planJson },
      error: null,
    }),
  };
  pvEqChain.eq.mockReturnValue(pvEqChain);

  // agent_runs.insert — just needs to succeed
  const agentRunsInsertMock = vi.fn().mockResolvedValue({ error: null });

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === "memory_files") {
      return {
        select: vi.fn().mockReturnValue(memoryEqChain),
        upsert: vi.fn().mockResolvedValue({ error: null }),
        update: updateMock,
      };
    }
    if (table === "plans") {
      return { select: vi.fn().mockReturnValue(plansEqChain) };
    }
    if (table === "plan_versions") {
      return { select: vi.fn().mockReturnValue(pvEqChain) };
    }
    if (table === "agent_runs") {
      return { insert: agentRunsInsertMock };
    }
    return { insert: insertMock };
  });

  return {
    from: fromMock,
    insertMock,
    agentRunsInsertMock,
  };
}

function makeAnthropicClient(responseText = "You had a solid week. Easy 6 miles today at RPE 4–5. Hamstring — do 3×15 single-leg calf raises before you head out.") {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: responseText }],
        usage: { input_tokens: 800, output_tokens: 250 },
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// runDailyCheckin — happy path
// ---------------------------------------------------------------------------

describe("runDailyCheckin", () => {
  it("returns telegramMessage and checkinLogEntry, persists agent_runs row", async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    (loadAthleteData as AnyMock).mockResolvedValue(ATHLETE_DATA);
    (fetchRecentActivities as AnyMock).mockResolvedValue(TWO_ACTIVITIES);
    const client = makeAnthropicClient("Good form today. Easy 6 at RPE 4.");
    (anthropicClient as AnyMock).mockReturnValue(client);

    const result = await runDailyCheckin(ATHLETE_ID, WELLNESS);

    expect(result.telegramMessage).toBe("Good form today. Easy 6 at RPE 4.");
    expect(result.checkinLogEntry).toBe(result.telegramMessage);

    // agent_runs row persisted with correct kind and model
    expect(db.agentRunsInsertMock).toHaveBeenCalledOnce();
    const [insertArg] = (db.agentRunsInsertMock as AnyMock).mock.calls[0] as [Record<string, unknown>];
    expect(insertArg.kind).toBe("daily_checkin");
    expect(insertArg.model).toBe("claude-sonnet-4-6");
    expect(typeof insertArg.cost_usd).toBe("number");
    expect((insertArg.cost_usd as number)).toBeGreaterThan(0);
  });

  it("makes the Claude call with system prompt and user message", async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    (loadAthleteData as AnyMock).mockResolvedValue(ATHLETE_DATA);
    (fetchRecentActivities as AnyMock).mockResolvedValue([]);
    const client = makeAnthropicClient();
    (anthropicClient as AnyMock).mockReturnValue(client);

    await runDailyCheckin(ATHLETE_ID, WELLNESS);

    expect(client.messages.create).toHaveBeenCalledOnce();
    const [call] = (client.messages.create as AnyMock).mock.calls[0] as [Record<string, unknown>];
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(typeof call.system).toBe("string");
    expect((call.system as string).length).toBeGreaterThan(0);
    const msgs = call.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toContain("wellness battery");
  });

  it("falls through with empty Strava when no activities exist", async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    (loadAthleteData as AnyMock).mockResolvedValue(ATHLETE_DATA);
    (fetchRecentActivities as AnyMock).mockResolvedValue([]);
    const client = makeAnthropicClient("Rest day looks right given the zeros.");
    (anthropicClient as AnyMock).mockReturnValue(client);

    const result = await runDailyCheckin(ATHLETE_ID, WELLNESS);
    expect(result.telegramMessage).toBeTruthy();

    // The user message should include the no-activities fallback text
    const [call] = (client.messages.create as AnyMock).mock.calls[0] as [Record<string, unknown>];
    const msgs = call.messages as Array<{ content: string }>;
    expect(msgs[0]!.content).toContain("No Strava activities found");
  });
});

// ---------------------------------------------------------------------------
// runDailyCheckin — Strava hard requirement
// ---------------------------------------------------------------------------

describe("runDailyCheckin — Strava hard requirement", () => {
  it("broken token: throws StravaTokenBrokenError, agent_runs row recorded, Claude not called", async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    (loadAthleteData as AnyMock).mockResolvedValue(ATHLETE_DATA);
    (fetchRecentActivities as AnyMock).mockRejectedValue(new Error("refresh_token rejected by Strava"));
    const client = makeAnthropicClient();
    (anthropicClient as AnyMock).mockReturnValue(client);

    await expect(runDailyCheckin(ATHLETE_ID, WELLNESS)).rejects.toThrow("Strava token refresh failed or was revoked");

    // Claude must not be called
    expect(client.messages.create).not.toHaveBeenCalled();

    // agent_runs row recorded with zero tokens and strava_token_broken error
    expect(db.agentRunsInsertMock).toHaveBeenCalledOnce();
    const [insertArg] = (db.agentRunsInsertMock as AnyMock).mock.calls[0] as [Record<string, unknown>];
    expect(insertArg.error).toBe("strava_token_broken");
    expect(insertArg.input_tokens).toBe(0);
    expect(insertArg.output_tokens).toBe(0);
    expect(insertArg.result_summary).toBe("aborted: broken strava token");
  });

  it("valid token: fetchRecentActivities called and activities appear in message", async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    (loadAthleteData as AnyMock).mockResolvedValue(ATHLETE_DATA);
    (fetchRecentActivities as AnyMock).mockResolvedValue(TWO_ACTIVITIES);
    const client = makeAnthropicClient("Strong week — 14 miles logged.");
    (anthropicClient as AnyMock).mockReturnValue(client);

    await runDailyCheckin(ATHLETE_ID, WELLNESS);

    expect(fetchRecentActivities).toHaveBeenCalledOnce();

    // Activities should appear in the Claude user message (the table rows)
    const [call] = (client.messages.create as AnyMock).mock.calls[0] as [Record<string, unknown>];
    const msgs = call.messages as Array<{ content: string }>;
    expect(msgs[0]!.content).toContain("2026-05-24"); // first activity date
  });
});

// ---------------------------------------------------------------------------
// buildUserMessage — snapshot test
// ---------------------------------------------------------------------------

describe("buildUserMessage", () => {
  it("snapshot: known inputs produce stable user message format", () => {
    const msg = buildUserMessage({
      dateStr: "2026-05-26",
      weekN: 8,
      dayOfWeek: "Tuesday",
      athleteProfileMd: "## Schedule\nTraining days per week: 5",
      injuryLogMd: "## Active\n- Left hamstring, resolving",
      recentCheckinsMd: "## 2026-05-25\n\nGood easy run. On track.",
      activities: TWO_ACTIVITIES,
      plannedDay: {
        day: "Tuesday",
        type: "easy",
        description: "Easy recovery run",
        planned_distance_miles: 6,
        target_rpe: [3, 4],
      },
      wellness: {
        readiness: 6,
        soreness_score: 4,
        soreness_body_part: "left hamstring",
        note: "A bit stiff this morning",
      },
      asthma: false,
    });

    // Key structural checks (snapshot would be overkill for a markdown string;
    // these verify the critical sections are present).
    expect(msg).toContain("2026-05-26 (week 8 of plan)");
    expect(msg).toContain("Athlete profile");
    expect(msg).toContain("Training days per week: 5");
    expect(msg).toContain("Active injuries");
    expect(msg).toContain("Left hamstring, resolving");
    expect(msg).toContain("Recent check-ins");
    expect(msg).toContain("2026-05-25");
    expect(msg).toContain("Last 14 days of training");
    expect(msg).toContain("2026-05-24");  // activity date
    expect(msg).toContain("2026-05-26");  // second activity
    expect(msg).toContain("Today's planned workout");
    expect(msg).toContain("Easy recovery run");
    expect(msg).toContain("6 miles");
    expect(msg).toContain("RPE: 3–4");
    expect(msg).toContain("wellness battery");
    expect(msg).toContain("Readiness: 6/10");
    expect(msg).toContain("Soreness: 4/10 (left hamstring)");
    expect(msg).toContain("A bit stiff this morning");
  });

  it("includes asthma flag in user message when athlete has asthma", () => {
    const msg = buildUserMessage({
      dateStr: "2026-05-26",
      weekN: 1,
      dayOfWeek: "Monday",
      athleteProfileMd: "",
      injuryLogMd: "",
      recentCheckinsMd: "No prior check-ins.",
      activities: [],
      plannedDay: null,
      wellness: WELLNESS,
      asthma: true,
    });

    expect(msg).toContain("Asthma flag: Yes");
  });

  it("shows 'no specific area' when soreness_body_part is null", () => {
    const msg = buildUserMessage({
      dateStr: "2026-05-26",
      weekN: 1,
      dayOfWeek: "Monday",
      athleteProfileMd: "",
      injuryLogMd: "",
      recentCheckinsMd: "No prior check-ins.",
      activities: [],
      plannedDay: null,
      wellness: { readiness: 5, soreness_score: 2, soreness_body_part: null, note: null },
      asthma: false,
    });

    expect(msg).toContain("no specific area");
    expect(msg).toContain("no note");
  });
});

// ---------------------------------------------------------------------------
// appendCheckinEntry
// ---------------------------------------------------------------------------

describe("appendCheckinEntry", () => {
  it("creates a new document on first call", async () => {
    const upsertMock = vi.fn().mockResolvedValue({ error: null });
    const eqChain = {
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    eqChain.eq.mockReturnValue(eqChain);

    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue(eqChain),
        upsert: upsertMock,
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) }),
      }),
    });

    await appendCheckinEntry(ATHLETE_ID, "2026-05-26", "Solid session today.");

    expect(upsertMock).toHaveBeenCalledOnce();
    const [upserted] = (upsertMock as AnyMock).mock.calls[0] as [{ content_md: string }];
    expect(upserted.content_md).toContain("# Check-in Log");
    expect(upserted.content_md).toContain("## 2026-05-26");
    expect(upserted.content_md).toContain("Solid session today.");
  });

  it("appends a new entry without overwriting existing content", async () => {
    const existingContent =
      "# Check-in Log\n\nAppend-only.\n\n## 2026-05-25\n\nYesterday was good.";
    const updateEqMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    const updateMock = vi.fn().mockReturnValue({ eq: updateEqMock });

    const eqChain = {
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { content_md: existingContent },
        error: null,
      }),
    };
    eqChain.eq.mockReturnValue(eqChain);

    (supabaseAdmin as AnyMock).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue(eqChain),
        update: updateMock,
      }),
    });

    await appendCheckinEntry(ATHLETE_ID, "2026-05-26", "Today's coaching note.");

    expect(updateMock).toHaveBeenCalledOnce();
    const [updateArg] = (updateMock as AnyMock).mock.calls[0] as [{ content_md: string }];
    expect(updateArg.content_md).toContain("Yesterday was good.");
    expect(updateArg.content_md).toContain("## 2026-05-26");
    expect(updateArg.content_md).toContain("Today's coaching note.");
  });
});
