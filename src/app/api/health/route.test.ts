import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  supabaseAdmin: vi.fn(),
}));

import { GET } from "./route";
import { supabaseAdmin } from "@/lib/db";

function makeSupabaseMock(result: { data?: unknown; error: null | { message: string } }) {
  const limit = vi.fn().mockResolvedValue(result);
  const select = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ select });
  return { from };
}

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the expected response shape", async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeSupabaseMock({ data: [], error: null }) as ReturnType<typeof supabaseAdmin>
    );

    const response = await GET();
    const body = await response.json();

    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("checks.postgres.ok");
    expect(body).toHaveProperty("checks.postgres.latency_ms");
    expect(body).toHaveProperty("checks.anthropic");
    expect(body).toHaveProperty("checks.telegram");
    expect(body).toHaveProperty("checks.strava");
  });

  it("returns status=ok when postgres succeeds", async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeSupabaseMock({ data: [], error: null }) as ReturnType<typeof supabaseAdmin>
    );

    const response = await GET();
    const body = await response.json();

    expect(body.status).toBe("ok");
    expect(body.checks.postgres.ok).toBe(true);
    expect(typeof body.checks.postgres.latency_ms).toBe("number");
  });

  it("returns status=error when postgres fails", async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeSupabaseMock({ error: { message: "connection refused" } }) as ReturnType<typeof supabaseAdmin>
    );

    const response = await GET();
    const body = await response.json();

    expect(body.status).toBe("error");
    expect(body.checks.postgres.ok).toBe(false);
    expect(body.checks.postgres.error).toBe("connection refused");
  });

  it("returns status=error when supabaseAdmin throws", async () => {
    vi.mocked(supabaseAdmin).mockImplementation(() => {
      throw new Error("no env vars");
    });

    const response = await GET();
    const body = await response.json();

    expect(body.status).toBe("error");
    expect(body.checks.postgres.ok).toBe(false);
  });

  it("returns configured=false for all stub checks", async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeSupabaseMock({ data: [], error: null }) as ReturnType<typeof supabaseAdmin>
    );

    const response = await GET();
    const body = await response.json();

    expect(body.checks.anthropic.configured).toBe(false);
    expect(body.checks.telegram.configured).toBe(false);
    expect(body.checks.strava.configured).toBe(false);
  });

  it("sets Cache-Control: no-store header", async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeSupabaseMock({ data: [], error: null }) as ReturnType<typeof supabaseAdmin>
    );

    const response = await GET();

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
