import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ supabaseAdmin: vi.fn() }));

import { supabaseAdmin } from "@/lib/db";
import { appendWellnessRow } from "../wellness-log";
import type { WellnessEntry } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = "athlete-1";

const ENTRY: WellnessEntry = {
  date: "2026-05-26",
  time: "09:00",
  readiness: 7,
  soreness: 3,
  body_part: "left hamstring",
  note: "felt good",
};

const ENTRY_NO_BODY_PART: WellnessEntry = {
  ...ENTRY,
  body_part: "—",
  note: "—",
};

// Build a mock db that simulates either no existing file or an existing one.
function makeDb(existingContent: string | null) {
  const upsertMock = vi.fn().mockResolvedValue({ error: null });
  const updateMock = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    }),
  });

  const db = {
    from: vi.fn().mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: existingContent !== null ? { content_md: existingContent } : null,
              error: null,
            }),
          }),
        }),
      }),
      upsert: upsertMock,
      update: updateMock,
    })),
  };

  return { db, upsertMock, updateMock };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("appendWellnessRow", () => {
  it("creates a new document when no file exists", async () => {
    const { db, upsertMock } = makeDb(null);
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    await appendWellnessRow(ATHLETE_ID, ENTRY);

    expect(upsertMock).toHaveBeenCalledOnce();
    const [record] = upsertMock.mock.calls[0] as AnyMock;
    expect(record.athlete_id).toBe(ATHLETE_ID);
    expect(record.file_name).toBe("wellness_log.md");
    expect(record.content_md).toContain("# Wellness Log");
    expect(record.content_md).toContain("## Entries");
    expect(record.content_md).toContain("| date | time | readiness | soreness | body_part | note |");
    expect(record.content_md).toContain("| 2026-05-26 | 09:00 | 7 | 3 | left hamstring | felt good |");
  });

  it("appends a row to an existing file", async () => {
    const existingContent = [
      "# Wellness Log",
      "",
      "## Entries",
      "",
      "| date | time | readiness | soreness | body_part | note |",
      "|------|------|-----------|----------|-----------|------|",
      "| 2026-05-25 | 08:00 | 6 | 2 | — | — |",
    ].join("\n");

    const { db, updateMock } = makeDb(existingContent);
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    await appendWellnessRow(ATHLETE_ID, ENTRY);

    expect(updateMock).toHaveBeenCalledOnce();
    const [record] = updateMock.mock.calls[0] as AnyMock;
    expect(record.content_md).toContain("| 2026-05-25 | 08:00 | 6 | 2 | — | — |");
    expect(record.content_md).toContain("| 2026-05-26 | 09:00 | 7 | 3 | left hamstring | felt good |");
    // New row should follow the old row
    const oldIdx = record.content_md.indexOf("2026-05-25");
    const newIdx = record.content_md.indexOf("2026-05-26");
    expect(newIdx).toBeGreaterThan(oldIdx);
  });

  it("formats null body_part as '—'", async () => {
    const { db, upsertMock } = makeDb(null);
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    await appendWellnessRow(ATHLETE_ID, ENTRY_NO_BODY_PART);

    const [record] = upsertMock.mock.calls[0] as AnyMock;
    expect(record.content_md).toContain("| — |");
  });

  it("formats null note as '—'", async () => {
    const { db, upsertMock } = makeDb(null);
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    await appendWellnessRow(ATHLETE_ID, ENTRY_NO_BODY_PART);

    const [record] = upsertMock.mock.calls[0] as AnyMock;
    // Both body_part and note are "—" — confirm both appear
    const row = record.content_md.split("\n").at(-1) as string;
    expect(row).toContain("| — | — |");
  });
});
