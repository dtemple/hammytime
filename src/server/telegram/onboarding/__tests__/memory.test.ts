import { describe, it, expect, vi, beforeEach } from "vitest";
import { upsertProfileSection } from "../memory";

vi.mock("@/lib/db", () => ({
  supabaseAdmin: vi.fn(),
}));

import { supabaseAdmin } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDB = any;

function makeDb(existingContent: string | null) {
  const upsertMock = vi.fn().mockResolvedValue({ error: null });
  const maybeSingleMock = vi.fn().mockResolvedValue({
    data: existingContent !== null ? { content_md: existingContent } : null,
    error: null,
  });
  const eq2Mock = vi.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
  const eq1Mock = vi.fn().mockReturnValue({ eq: eq2Mock });
  const selectMock = vi.fn().mockReturnValue({ eq: eq1Mock });
  const fromMock = vi.fn().mockImplementation(() => ({
    select: selectMock,
    upsert: upsertMock,
  }));

  return { from: fromMock, _upsertMock: upsertMock };
}

beforeEach(() => vi.clearAllMocks());

describe("upsertProfileSection", () => {
  it("replaces an existing section", async () => {
    const { from, _upsertMock } = makeDb("## Identity\nName: Old\n\n## Schedule\nDays: 4");
    vi.mocked(supabaseAdmin).mockReturnValue({ from } as AnyDB);

    await upsertProfileSection("a1", "Identity", "Name: New\nAge: 30");

    const saved = (_upsertMock.mock.calls[0]![0] as { content_md: string }).content_md;
    expect(saved).toContain("## Identity\nName: New\nAge: 30");
    expect(saved).toContain("## Schedule\nDays: 4");
    expect(saved).not.toContain("Name: Old");
  });

  it("appends a new section when the file has existing content", async () => {
    const { from, _upsertMock } = makeDb("## Identity\nName: Alice");
    vi.mocked(supabaseAdmin).mockReturnValue({ from } as AnyDB);

    await upsertProfileSection("a1", "Goals", "Distance: Marathon");

    const saved = (_upsertMock.mock.calls[0]![0] as { content_md: string }).content_md;
    expect(saved).toContain("## Goals\nDistance: Marathon");
    expect(saved).toContain("## Identity\nName: Alice");
  });

  it("writes without leading newline when file is empty", async () => {
    const { from, _upsertMock } = makeDb("");
    vi.mocked(supabaseAdmin).mockReturnValue({ from } as AnyDB);

    await upsertProfileSection("a1", "Identity", "Name: Bob");

    const saved = (_upsertMock.mock.calls[0]![0] as { content_md: string }).content_md;
    expect(saved).toBe("## Identity\nName: Bob");
    expect(saved.startsWith("\n")).toBe(false);
  });

  it("creates a new file when the row doesn't exist", async () => {
    const { from, _upsertMock } = makeDb(null);
    vi.mocked(supabaseAdmin).mockReturnValue({ from } as AnyDB);

    await upsertProfileSection("a1", "Schedule", "Days: 5");

    const saved = (_upsertMock.mock.calls[0]![0] as { content_md: string }).content_md;
    expect(saved).toBe("## Schedule\nDays: 5");
  });

  it("replaces a section at the end of the file with no trailing ##", async () => {
    const { from, _upsertMock } = makeDb("## Identity\nName: Alice\n\n## Goals\nDistance: 5K");
    vi.mocked(supabaseAdmin).mockReturnValue({ from } as AnyDB);

    await upsertProfileSection("a1", "Goals", "Distance: Marathon");

    const saved = (_upsertMock.mock.calls[0]![0] as { content_md: string }).content_md;
    expect(saved).toContain("## Goals\nDistance: Marathon");
    expect(saved).not.toContain("Distance: 5K");
  });
});
