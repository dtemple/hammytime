import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadOnboardingState, advanceQuestion, resetOnboarding } from "../state";

vi.mock("@/lib/db", () => ({
  supabaseAdmin: vi.fn(),
}));

import { supabaseAdmin } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDB = any;

function makeMock(selectResult: unknown, rpcError: unknown = null) {
  const rpcMock = vi.fn().mockResolvedValue({ error: rpcError });
  const singleMock = vi.fn().mockResolvedValue(selectResult);
  const eqMock = vi.fn().mockReturnValue({ single: singleMock });
  const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
  const fromMock = vi.fn().mockReturnValue({ select: selectMock });
  return {
    from: fromMock,
    rpc: rpcMock,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("loadOnboardingState", () => {
  it("returns parsed state from DB", async () => {
    const db = makeMock({
      data: { onboarding_state: { step: 1, question: 2, partial: { name: "Alice" } } },
      error: null,
    });
    vi.mocked(supabaseAdmin).mockReturnValue(db as AnyDB);

    const state = await loadOnboardingState("athlete-1");
    expect(state).toEqual({ step: 1, question: 2, partial: { name: "Alice" } });
  });

  it("defaults question to 0 when field is absent (legacy rows)", async () => {
    const db = makeMock({
      data: { onboarding_state: { step: 0, partial: {} } },
      error: null,
    });
    vi.mocked(supabaseAdmin).mockReturnValue(db as AnyDB);

    const state = await loadOnboardingState("athlete-1");
    expect(state.question).toBe(0);
  });

  it("returns initial state on DB error", async () => {
    const db = makeMock({ data: null, error: { message: "fail" } });
    vi.mocked(supabaseAdmin).mockReturnValue(db as AnyDB);

    const state = await loadOnboardingState("athlete-1");
    expect(state).toEqual({ step: 0, question: 0, partial: {} });
  });
});

describe("advanceQuestion", () => {
  it("calls set_onboarding_state RPC with correct args", async () => {
    const db = makeMock({}, null);
    vi.mocked(supabaseAdmin).mockReturnValue(db as AnyDB);

    const newState = { step: 0, question: 1, partial: { name: "Bob" } };
    await advanceQuestion("athlete-1", newState);

    expect(db.rpc).toHaveBeenCalledWith("set_onboarding_state", {
      p_athlete_id: "athlete-1",
      p_new_state: newState,
    });
  });

  it("throws on RPC error", async () => {
    const db = makeMock({}, { message: "rpc error" });
    vi.mocked(supabaseAdmin).mockReturnValue(db as AnyDB);

    await expect(
      advanceQuestion("athlete-1", { step: 0, question: 0, partial: {} })
    ).rejects.toThrow("advanceQuestion failed");
  });
});

describe("resetOnboarding", () => {
  it("calls set_onboarding_state with initial state", async () => {
    const db = makeMock({}, null);
    vi.mocked(supabaseAdmin).mockReturnValue(db as AnyDB);

    await resetOnboarding("athlete-1");

    expect(db.rpc).toHaveBeenCalledWith("set_onboarding_state", {
      p_athlete_id: "athlete-1",
      p_new_state: { step: 0, question: 0, partial: {} },
    });
  });
});
