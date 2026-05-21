import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseDateFlexible } from "../parsing/dates";
import { parseFinishTime } from "../parsing/durations";
import { parseDistanceMiles } from "../parsing/distance";

// ---------------------------------------------------------------------------
// parseDateFlexible
// ---------------------------------------------------------------------------

describe("parseDateFlexible", () => {
  it("parses ISO YYYY-MM-DD", () => {
    const r = parseDateFlexible("2026-08-30");
    expect(r).toEqual({ ok: true, value: "2026-08-30" });
  });

  it("parses long month name with year", () => {
    const r = parseDateFlexible("August 30 2026");
    expect(r).toEqual({ ok: true, value: "2026-08-30" });
  });

  it("parses short month name with year", () => {
    const r = parseDateFlexible("Aug 30 2026");
    expect(r).toEqual({ ok: true, value: "2026-08-30" });
  });

  it("parses month name with comma", () => {
    const r = parseDateFlexible("Aug 30, 2026");
    expect(r).toEqual({ ok: true, value: "2026-08-30" });
  });

  it("parses slash MM/DD/YYYY", () => {
    const r = parseDateFlexible("8/30/2026");
    expect(r).toEqual({ ok: true, value: "2026-08-30" });
  });

  it("parses slash MM/DD/YY", () => {
    const r = parseDateFlexible("8/30/26");
    expect(r).toEqual({ ok: true, value: "2026-08-30" });
  });

  it("parses day-first format: 30 Aug 2026", () => {
    const r = parseDateFlexible("30 Aug 2026");
    expect(r).toEqual({ ok: true, value: "2026-08-30" });
  });

  it("infers next year when month/day is in the past (no year given)", () => {
    // Jan 1 with no year — always in the past if not today, bumps to next year
    const r = parseDateFlexible("Jan 1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const year = parseInt(r.value.split("-")[0]!, 10);
      expect(year).toBeGreaterThanOrEqual(new Date().getFullYear());
    }
  });

  it("rejects gibberish", () => {
    expect(parseDateFlexible("not a date").ok).toBe(false);
    expect(parseDateFlexible("").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseFinishTime
// ---------------------------------------------------------------------------

describe("parseFinishTime", () => {
  it("parses HH:MM:SS", () => {
    expect(parseFinishTime("3:45:00")).toEqual({ ok: true, value: 13500 });
  });

  it("parses H:MM:SS", () => {
    expect(parseFinishTime("1:30:00")).toEqual({ ok: true, value: 5400 });
  });

  it("parses '3h 45m'", () => {
    expect(parseFinishTime("3h 45m")).toEqual({ ok: true, value: 13500 });
  });

  it("parses '3h45m' (no space)", () => {
    expect(parseFinishTime("3h45m")).toEqual({ ok: true, value: 13500 });
  });

  it("parses '225 minutes'", () => {
    expect(parseFinishTime("225 minutes")).toEqual({ ok: true, value: 13500 });
  });

  it("parses '225 min'", () => {
    expect(parseFinishTime("225 min")).toEqual({ ok: true, value: 13500 });
  });

  it("parses MM:SS for short runs", () => {
    // 10:00 = 600 seconds — exactly at the minimum
    expect(parseFinishTime("10:00")).toEqual({ ok: true, value: 600 });
  });

  it("rejects times that are too fast", () => {
    expect(parseFinishTime("5:00").ok).toBe(false);   // 300s < 600s minimum
    expect(parseFinishTime("0:30").ok).toBe(false);
  });

  it("rejects times that are too slow", () => {
    expect(parseFinishTime("101h").ok).toBe(false);
  });

  it("rejects invalid seconds", () => {
    expect(parseFinishTime("3:45:99").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseDistanceMiles
// ---------------------------------------------------------------------------

describe("parseDistanceMiles", () => {
  it("parses numeric miles", () => {
    expect(parseDistanceMiles("26.2")).toEqual({ ok: true, value: 26.2 });
  });

  it("parses numeric miles with unit", () => {
    expect(parseDistanceMiles("26.2 mi")).toEqual({ ok: true, value: 26.2 });
    expect(parseDistanceMiles("13.1 miles")).toEqual({ ok: true, value: 13.1 });
  });

  it("converts km to miles", () => {
    const r = parseDistanceMiles("42.2 km");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeCloseTo(26.2, 0);
  });

  it("resolves 'marathon' alias", () => {
    expect(parseDistanceMiles("marathon")).toEqual({ ok: true, value: 26.2 });
    expect(parseDistanceMiles("full marathon")).toEqual({ ok: true, value: 26.2 });
  });

  it("resolves 'half' alias", () => {
    expect(parseDistanceMiles("half")).toEqual({ ok: true, value: 13.1 });
    expect(parseDistanceMiles("half marathon")).toEqual({ ok: true, value: 13.1 });
    expect(parseDistanceMiles("hm")).toEqual({ ok: true, value: 13.1 });
  });

  it("resolves '5k' alias", () => {
    expect(parseDistanceMiles("5k")).toEqual({ ok: true, value: 3.107 });
  });

  it("resolves '10k' alias", () => {
    expect(parseDistanceMiles("10k")).toEqual({ ok: true, value: 6.214 });
  });

  it("resolves ultra aliases", () => {
    expect(parseDistanceMiles("ultra")).toEqual({ ok: true, value: 50 });
    expect(parseDistanceMiles("50k")).toEqual({ ok: true, value: 31.069 });
    expect(parseDistanceMiles("100k")).toEqual({ ok: true, value: 62.137 });
  });

  it("rejects unrecognised input", () => {
    expect(parseDistanceMiles("a long way").ok).toBe(false);
    expect(parseDistanceMiles("").ok).toBe(false);
  });
});

// Suppress unused import warnings for beforeEach/afterEach if not used
void beforeEach;
void afterEach;
