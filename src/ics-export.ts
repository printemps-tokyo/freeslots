/**
 * Pure iCalendar (.ics) export of free slots. Each free slot becomes a VEVENT
 * with UTC timestamps (JST has no DST, so JST = UTC+9 always). Kept
 * side-effect-free so the formatting is easy to unit test.
 */
import type { DayFreeSlots } from "./freeslots.js";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format an absolute instant as an iCalendar UTC timestamp (YYYYMMDDTHHMMSSZ). */
export function utcStamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/**
 * Convert a JST wall-clock time (a "YYYY-MM-DD" date plus minutes from JST
 * midnight) into an iCalendar UTC timestamp.
 */
export function jstWallToUtcStamp(date: string, minutes: number): string {
  const [y, m, d] = date.split("-").map(Number);
  // JST midnight on `date` as a UTC instant, then add the minute offset.
  const jstMidnightUtcMs = Date.UTC(y as number, (m as number) - 1, d) - JST_OFFSET_MS;
  return utcStamp(jstMidnightUtcMs + minutes * 60_000);
}

export interface IcsOptions {
  /** Event summary/title (default "Free"). */
  summary?: string;
  /** DTSTAMP value (UTC stamp). Pass a fixed value for deterministic output. */
  dtstamp: string;
}

/** Build an iCalendar document with one VEVENT per free slot. */
export function buildIcs(days: DayFreeSlots[], opts: IcsOptions): string {
  const summary = opts.summary ?? "Free";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//printemps-tokyo//freeslots//EN",
    "CALSCALE:GREGORIAN",
  ];

  for (const day of days) {
    for (const [i, slot] of day.slots.entries()) {
      lines.push(
        "BEGIN:VEVENT",
        `UID:${day.date}-${slot.startMin}-${i}@freeslots`,
        `DTSTAMP:${opts.dtstamp}`,
        `DTSTART:${jstWallToUtcStamp(day.date, slot.startMin)}`,
        `DTEND:${jstWallToUtcStamp(day.date, slot.endMin)}`,
        `SUMMARY:${summary}`,
        "END:VEVENT",
      );
    }
  }

  lines.push("END:VCALENDAR");
  // iCalendar requires CRLF line endings.
  return lines.join("\r\n") + "\r\n";
}
