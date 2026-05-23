import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ supabaseAdmin: vi.fn() }));
vi.mock("./onboarding/index", () => ({
  handleOnboardingMessage: vi.fn().mockResolvedValue(undefined),
  handleOnboardingCallback: vi.fn().mockResolvedValue(undefined),
  onboardingSteps: new Array(7),
  resetOnboarding: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("child_process", () => ({ execSync: vi.fn().mockReturnValue("abc1234 — test commit") }));
// Prevent Bot constructor from throwing — we never call getBot() in these tests
vi.mock("grammy", () => ({ Bot: vi.fn(), Context: vi.fn() }));

import { supabaseAdmin } from "@/lib/db";
import { handleInboundText } from "./bot";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = "athlete-1";
const CHAT_ID = 999;

// Minimal grammy Context mock
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    chat: { id: CHAT_ID },
    reply: vi.fn().mockResolvedValue(undefined),
    message: { text: "hi" },
    ...overrides,
  };
}

// Builds a db mock that returns a post-onboarding athlete with a given plan_versions status
function makeDb(versionStatus: string | null, hasPlan = true) {
  const athlete = {
    id: ATHLETE_ID,
    telegram_chat_id: String(CHAT_ID),
    onboarding_state: { step: 7 }, // terminal — past all onboarding steps
  };

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "athletes") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: athlete, error: null }),
            }),
          }),
        };
      }
      if (table === "plans") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: hasPlan ? { id: "plan-1" } : null,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "plan_versions") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: versionStatus ? { status: versionStatus } : null,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Post-onboarding routing — awaiting_paste
// ---------------------------------------------------------------------------

describe("handleInboundText — post-onboarding routing", () => {
  it("replies with setup placeholder when plan_versions status is awaiting_paste", async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb("awaiting_paste"));
    const ctx = makeCtx();

    await handleInboundText(ctx as AnyMock);

    expect(ctx.reply).toHaveBeenCalledWith(
      "Your plan is being set up. Daily coaching is coming soon."
    );
  });

  it("does not include a /p/ URL in the awaiting_paste reply", async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb("awaiting_paste"));
    const ctx = makeCtx();

    await handleInboundText(ctx as AnyMock);

    const replyText = (ctx.reply as AnyMock).mock.calls[0]![0] as string;
    expect(replyText).not.toContain("/p/");
    expect(replyText).not.toContain("http");
  });

  it("replies with active message when plan_versions status is active", async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb("active"));
    const ctx = makeCtx();

    await handleInboundText(ctx as AnyMock);

    expect(ctx.reply).toHaveBeenCalledWith(
      "All set. Daily check-ins start when that side of the bot ships."
    );
  });

  it("replies with help-path message when no plan row exists", async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb(null, false));
    const ctx = makeCtx();

    await handleInboundText(ctx as AnyMock);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("David's on it")
    );
  });
});
