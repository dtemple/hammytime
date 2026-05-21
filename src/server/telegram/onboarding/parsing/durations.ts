import type { ParseResult } from "../types";

const MIN_SECONDS = 600;       // 10 minutes
const MAX_SECONDS = 360000;    // 100 hours

export function parseFinishTime(text: string): ParseResult<number> {
  const v = text.trim().toLowerCase();

  // "225 minutes" / "225 min"
  const minutesOnly = /^(\d+)\s*(?:minutes?|mins?)$/.exec(v);
  if (minutesOnly) {
    const total = parseInt(minutesOnly[1]!, 10) * 60;
    return validate(total);
  }

  // "3h 45m" / "3h45m" / "3h" / "45m"
  const hm = /^(?:(\d+)h\s*)?(?:(\d+)m)?$/.exec(v);
  if (hm && (hm[1] ?? hm[2])) {
    const h = hm[1] ? parseInt(hm[1], 10) : 0;
    const m = hm[2] ? parseInt(hm[2], 10) : 0;
    const total = h * 3600 + m * 60;
    return validate(total);
  }

  // Colon-separated: HH:MM:SS, H:MM:SS, or MM:SS
  const parts = v.split(":").map((p) => parseInt(p.trim(), 10));
  if (parts.every((p) => !isNaN(p))) {
    if (parts.length === 3) {
      const [h, m, s] = parts as [number, number, number];
      if (m >= 60 || s >= 60) return { ok: false, error: "Minutes and seconds must be under 60." };
      return validate(h * 3600 + m * 60 + s);
    }
    if (parts.length === 2) {
      const [m, s] = parts as [number, number];
      if (s >= 60) return { ok: false, error: "Seconds must be under 60." };
      return validate(m * 60 + s);
    }
  }

  return {
    ok: false,
    error: "Format as H:MM:SS (e.g. 3:45:00) or '3h 45m' or '225 minutes'.",
  };
}

function validate(seconds: number): ParseResult<number> {
  if (seconds < MIN_SECONDS)
    return { ok: false, error: "That time seems too fast — double-check and try again." };
  if (seconds > MAX_SECONDS)
    return { ok: false, error: "That time seems too slow — anything under 100 hours is fine." };
  return { ok: true, value: seconds };
}

export function formatFinishTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
