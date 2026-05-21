import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/agent/byo-plan", () => ({
  handleBuildPath: vi.fn().mockResolvedValue(undefined),
  handleHelpPath: vi.fn().mockResolvedValue(undefined),
}));

import { handleBuildPath, handleHelpPath } from "@/server/agent/byo-plan";
import { planForkStep } from "./06-plan-fork";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = "athlete-123";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planForkStep.handleMessage", () => {
  const handle = planForkStep.handleMessage!;

  it("routes 'build' to handleBuildPath and returns done=true", async () => {
    const result = await handle("build", {}, ATHLETE_ID);
    expect(handleBuildPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
    if (result.done) {
      expect((result.newPartial as AnyMock).chosen).toBe("build");
    }
  });

  it("routes 'b' (shorthand) to handleBuildPath", async () => {
    const result = await handle("b", {}, ATHLETE_ID);
    expect(handleBuildPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
  });

  it("routes 'BUILD' (case-insensitive) to handleBuildPath", async () => {
    const result = await handle("BUILD", {}, ATHLETE_ID);
    expect(handleBuildPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
  });

  it("routes 'help' to handleHelpPath and returns done=true", async () => {
    const result = await handle("help", {}, ATHLETE_ID);
    expect(handleHelpPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
    if (result.done) {
      expect((result.newPartial as AnyMock).chosen).toBe("help");
    }
  });

  it("routes 'h' (shorthand) to handleHelpPath", async () => {
    const result = await handle("h", {}, ATHLETE_ID);
    expect(handleHelpPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
  });

  it("re-asks on unknown input", async () => {
    const result = await handle("upload", {}, ATHLETE_ID);
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.reply).toMatch(/Pick one/);
    }
    expect(handleBuildPath).not.toHaveBeenCalled();
    expect(handleHelpPath).not.toHaveBeenCalled();
  });

  it("handles empty partial (first message after initialPrompt)", async () => {
    const result = await handle("build", {}, ATHLETE_ID);
    expect(result.done).toBe(true);
  });

  it("handles choosing_path sub_step explicitly set", async () => {
    const result = await handle("help", { sub_step: "choosing_path" }, ATHLETE_ID);
    expect(handleHelpPath).toHaveBeenCalledWith(ATHLETE_ID);
    expect(result.done).toBe(true);
  });
});
