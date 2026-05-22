import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/server/telegram/bot", () => ({ sendAndLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/server/admin/alerts", () => ({
  sendDavidAlert: vi.fn().mockResolvedValue(undefined),
}));

import { supabaseAdmin } from "@/lib/db";
import { sendAndLog } from "@/server/telegram/bot";
import { sendDavidAlert } from "@/server/admin/alerts";
import { POST } from "./route";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/plans/paste", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 8-week plan: base(1-3), cutback(4), taper(5-7), race(8)
// Peak volume = 24 mi (week 3). Taper at 80/60/40% of 24 = 20/15/10.
// Start 2026-09-07 + 56d = 2026-11-02 ≈ race 2026-11-01 (1d diff ✓)
function validPlanJson() {
  return JSON.stringify({
    schema_version: 1,
    meta: {
      athlete_name: "Annie",
      goal_race: {
        name: "NYC Marathon",
        date: "2026-11-01",
        distance_mi: 26.2,
        elevation_ft: 800,
        terrain: "road",
        target: "finish",
      },
      start_date: "2026-09-07",
      total_weeks: 8,
      weekly_availability: { days_per_week: 5, hours_per_week: 8 },
    },
    phases: [
      { name: "base", start_week: 1, end_week: 3, focus: "Build base." },
      { name: "cutback", start_week: 4, end_week: 4, focus: "Recovery." },
      { name: "taper", start_week: 5, end_week: 7, focus: "Taper." },
      { name: "race", start_week: 8, end_week: 8, focus: "Race." },
    ],
    weeks: [
      week(1, "base", 20, 6),
      week(2, "base", 22, 7),
      week(3, "base", 24, 8),
      week(4, "cutback", 18, 5),
      week(5, "taper", 20, 6),
      week(6, "taper", 15, 5),
      week(7, "taper", 10, 3),
      week(8, "race", 6, 2),
    ],
    compliance_rules: {
      hard_day_min_spacing_days: 2,
      max_week_volume_ramp_pct: 10,
      min_rest_days_per_week: 1,
      long_run_cap_pct_of_week: 35,
      cutback_week_frequency: 4,
      cutback_volume_reduction_pct_min: 20,
      cutback_volume_reduction_pct_max: 30,
    },
    race_strategy: {
      pacing_approach: "Even effort.",
      fueling_approach: "Gel every 45 min.",
      key_landmarks_to_brief: [],
    },
  });
}

function week(
  week_number: number,
  phase: string,
  volume: number,
  longRun: number
) {
  return {
    week_number,
    phase,
    focus: "Focus.",
    planned_volume_mi: volume,
    planned_elevation_ft: 500,
    key_notes: "",
    days: {
      mon: { type: "long_run", distance_mi: longRun, intensity_rpe: 5, description: "Long." },
      tue: { type: "easy", distance_mi: 5, intensity_rpe: 3, description: "Easy." },
      wed: { type: "rest", description: "Rest." },
      thu: { type: "easy", distance_mi: 5, intensity_rpe: 3, description: "Easy." },
      fri: { type: "rest", description: "Rest." },
      sat: { type: "easy", distance_mi: 4, intensity_rpe: 3, description: "Easy." },
      sun: { type: "easy", distance_mi: 3, intensity_rpe: 3, description: "Easy." },
    },
  };
}

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

function makeDb({
  linkToken = {
    id: "lt-1",
    athlete_id: "athlete-1",
    plan_version_id: "pv-1",
  },
  athlete = {
    id: "athlete-1",
    name: "Annie",
    notes: "Longest recent run: 10\nRecent avg miles/week: 20",
    telegram_chat_id: "999",
  },
  planVersion = { id: "pv-1", plan_id: "plan-1" },
  rpcError = null,
}: {
  linkToken?: object | null;
  athlete?: object | null;
  planVersion?: object | null;
  rpcError?: object | null;
} = {}) {
  const rpc = vi.fn().mockResolvedValue({ error: rpcError });

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === "link_tokens") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              is: vi.fn().mockReturnValue({
                gt: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: linkToken }),
                }),
              }),
            }),
          }),
        }),
      };
    }
    if (table === "athletes") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: athlete }),
          }),
        }),
      };
    }
    if (table === "plan_versions") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: planVersion }),
          }),
        }),
      };
    }
    return {};
  });

  return { fromMock, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("POST /api/plans/paste", () => {
  it("returns 400 on missing body fields", async () => {
    (supabaseAdmin as AnyMock).mockReturnValue({ from: vi.fn(), rpc: vi.fn() });
    const res = await POST(makeRequest({ token: "abc" })); // no plan_json
    expect(res.status).toBe(400);
  });

  it("returns 401 on invalid token", async () => {
    const db = makeDb({ linkToken: null });
    (supabaseAdmin as AnyMock).mockReturnValue({ from: db.fromMock, rpc: db.rpc });
    const res = await POST(makeRequest({ token: "bad", plan_json: "{}" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 with json_parse_error on malformed JSON", async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue({ from: db.fromMock, rpc: db.rpc });
    const res = await POST(makeRequest({ token: "valid", plan_json: "not json {{" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("json_parse_error");
  });

  it("returns 400 with errors array on schema-invalid plan", async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue({ from: db.fromMock, rpc: db.rpc });
    const res = await POST(
      makeRequest({ token: "valid", plan_json: JSON.stringify({ schema_version: 2 }) })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("returns 400 with errors array on rule-violating plan", async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue({ from: db.fromMock, rpc: db.rpc });
    // Plan with week 1 long run > 1.5× longest_recent (10mi) — cold_start_cap violation
    const planStr = validPlanJson().replace('"distance_mi":6', '"distance_mi":16');
    const res = await POST(makeRequest({ token: "valid", plan_json: planStr }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Array.isArray(body.errors)).toBe(true);
  });

  it("returns 200 with summary on valid plan, calls RPC + sendAndLog + sendDavidAlert", async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue({ from: db.fromMock, rpc: db.rpc });
    const res = await POST(makeRequest({ token: "valid", plan_json: validPlanJson() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.summary).toBe("string");
    expect(body.summary).toContain("NYC Marathon");
    expect(db.rpc).toHaveBeenCalledWith("accept_plan_paste", expect.objectContaining({
      p_plan_version_id: "pv-1",
      p_plan_id: "plan-1",
      p_total_weeks: 8,
    }));
    expect(sendAndLog).toHaveBeenCalled();
    expect(sendDavidAlert).toHaveBeenCalled();
  });
});
