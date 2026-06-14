/**
 * Pure formatting of free slots into the product's required Japanese output,
 * and the matching JSON shape.
 *
 * Human format, one line per day that has at least one free slot:
 *   M/D(W) H:MM〜H:MM、H:MM〜H:MM
 * where:
 *   - M/D: month/day with no leading zeros
 *   - (W):  Japanese weekday from WEEKDAY_CHARS indexed by JS getDay()
 *   - time: 24h, hour without leading zero, minute always 2 digits
 *   - range separator is the WAVE DASH "〜" (U+301C)
 *   - same-day slots joined by the IDEOGRAPHIC COMMA "、" (U+3001)
 *   - a single ASCII space between "(W)" and the first range
 */

import type { DayFreeSlots, FreeSlotMinutes } from "./freeslots.js";

/** Japanese weekday characters indexed by JS getDay() (0=Sun .. 6=Sat). */
export const WEEKDAY_CHARS = ["日", "月", "火", "水", "木", "金", "土"] as const;

const WAVE_DASH = "〜"; // 〜
const IDEOGRAPHIC_COMMA = "、"; // 、

/** Format minutes-from-midnight as "H:MM" (no leading zero on the hour). */
export function formatTime(min: number): string {
  const hour = Math.floor(min / 60);
  const minute = min % 60;
  return `${hour}:${minute < 10 ? `0${minute}` : minute}`;
}

/** "YYYY-MM-DD" -> "M/D" with no leading zeros. */
function monthDay(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return `${Number(m[2])}/${Number(m[3])}`;
}

/** Format one day's slots as a single human-readable line. */
export function formatDayLine(day: DayFreeSlots): string {
  const ranges = day.slots
    .map((s) => `${formatTime(s.startMin)}${WAVE_DASH}${formatTime(s.endMin)}`)
    .join(IDEOGRAPHIC_COMMA);
  const weekday = WEEKDAY_CHARS[day.weekday] ?? "";
  return `${monthDay(day.date)}(${weekday}) ${ranges}`;
}

/**
 * Format all days as the human output. Days without slots are already omitted
 * by `computeFreeSlots`, so this simply joins the day lines with newlines.
 */
export function formatSlots(days: DayFreeSlots[]): string {
  return days.map(formatDayLine).join("\n");
}

/** JSON entry for a day with free slots. */
export interface JsonDay {
  date: string;
  weekday: string;
  slots: { start: string; end: string }[];
}

/** Build the `--json` payload from per-day slots. */
export function toJson(days: DayFreeSlots[]): JsonDay[] {
  return days.map((day) => ({
    date: day.date,
    weekday: WEEKDAY_CHARS[day.weekday] ?? "",
    slots: day.slots.map((s: FreeSlotMinutes) => ({
      start: formatTime(s.startMin),
      end: formatTime(s.endMin),
    })),
  }));
}
