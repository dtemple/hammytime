import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/server/telegram/onboarding/memory", () => ({
  upsertProfileSection: vi.fn().mockResolvedValue(undefined),
}));

import { supabaseAdmin } from "@/lib/db";
import { upsertProfileSection } from "@/server/telegram/onboarding/memory";
import { anythingElseStep } from "./04-anything-else";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

function makeDb(updateError: null | { message: string } = null) {
  const updateMock = vi.fn().mockResolvedValue({ error: updateError });
  const eqMock = vi.fn().mockReturnValue({ error: updateError });
  updateMock.mockReturnValue({ eq: eqMock });
  const fromMock = vi.fn().mockReturnValue({ update: updateMock });
  return { from: fromMock, updateMock, eqMock };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// parseReply
// ---------------------------------------------------------------------------

describe("anythingElseStep.questions[0].parseReply", () => {
  const question = anythingElseStep.questions[0]!;

  it("returns the trimmed text for a freeform reply", () => {
    const result = question.parseReply("  I have bad knees and run mornings only  ", {});
    expect(result).toEqual({ ok: true, value: "I have bad knees and run mornings only" });
  });

  it("returns null for 'skip'", () => {
    expect(question.parseReply("skip", {})).toEqual({ ok: true, value: null });
    expect(question.parseReply("SKIP", {})).toEqual({ ok: true, value: null });
  });

  it("returns null for 'none'", () => {
    expect(question.parseReply("none", {})).toEqual({ ok: true, value: null });
    expect(question.parseReply("NONE", {})).toEqual({ ok: true, value: null });
  });

  it("returns null for empty string", () => {
    expect(question.parseReply("", {})).toEqual({ ok: true, value: null });
    expect(question.parseReply("   ", {})).toEqual({ ok: true, value: null });
  });

  it("truncates text over 2000 chars", () => {
    const long = "a".repeat(2100);
    const result = question.parseReply(long, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2000);
  });
});

// ---------------------------------------------------------------------------
// onComplete — profile section
// ---------------------------------------------------------------------------

describe("anythingElseStep.onComplete", () => {
  it("writes verbatim text to the profile section", async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db.from);
    // Provide a mock that has .from()
    (supabaseAdmin as AnyMock).mockReturnValue({ from: db.from });

    await anythingElseStep.onComplete("athlete-1", { anything_else: "I have asthma and use albuterol" });

    expect(upsertProfileSection).toHaveBeenCalledWith(
      "athlete-1",
      "Anything else",
      "I have asthma and use albuterol"
    );
  });

  it("writes _None reported._ when null", async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue({ from: db.from });

    await anythingElseStep.onComplete("athlete-1", { anything_else: null });

    expect(upsertProfileSection).toHaveBeenCalledWith(
      "athlete-1",
      "Anything else",
      "_None reported._"
    );
  });

  // ---------------------------------------------------------------------------
  // Asthma heuristic
  // ---------------------------------------------------------------------------

  it("sets asthma=true when text mentions 'asthma'", async () => {
    const eqFn = vi.fn().mockResolvedValue({ error: null });
    const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
    const fromFn = vi.fn().mockReturnValue({ update: updateFn });
    (supabaseAdmin as AnyMock).mockReturnValue({ from: fromFn });

    await anythingElseStep.onComplete("athlete-1", { anything_else: "I have asthma" });

    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ asthma: true })
    );
  });

  it("sets asthma=true when text mentions 'inhaler'", async () => {
    const eqFn = vi.fn().mockResolvedValue({ error: null });
    const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
    const fromFn = vi.fn().mockReturnValue({ update: updateFn });
    (supabaseAdmin as AnyMock).mockReturnValue({ from: fromFn });

    await anythingElseStep.onComplete("athlete-1", { anything_else: "I use an inhaler before races" });

    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ asthma: true })
    );
  });

  it("sets asthma=true when text mentions 'albuterol'", async () => {
    const eqFn = vi.fn().mockResolvedValue({ error: null });
    const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
    const fromFn = vi.fn().mockReturnValue({ update: updateFn });
    (supabaseAdmin as AnyMock).mockReturnValue({ from: fromFn });

    await anythingElseStep.onComplete("athlete-1", { anything_else: "Take albuterol before long runs" });

    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ asthma: true })
    );
  });

  it("does NOT set asthma=true for non-matching text", async () => {
    const eqFn = vi.fn().mockResolvedValue({ error: null });
    const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
    const fromFn = vi.fn().mockReturnValue({ update: updateFn });
    (supabaseAdmin as AnyMock).mockReturnValue({ from: fromFn });

    await anythingElseStep.onComplete("athlete-1", { anything_else: "I run early mornings, no issues" });

    expect(updateFn).not.toHaveBeenCalled();
  });

  it("does NOT set asthma=true when text is null", async () => {
    const eqFn = vi.fn().mockResolvedValue({ error: null });
    const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
    const fromFn = vi.fn().mockReturnValue({ update: updateFn });
    (supabaseAdmin as AnyMock).mockReturnValue({ from: fromFn });

    await anythingElseStep.onComplete("athlete-1", { anything_else: null });

    expect(updateFn).not.toHaveBeenCalled();
  });
});
