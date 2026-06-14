/**
 * Pure free-slot computation.
 *
 * Given busy events (absolute epoch ms intervals) and business rules, produce
 * the free meeting slots per day. All day-bucketing and clock math happen in
 * Asia/Tokyo so the result matches the printed output exactly.
 *
 * Algorithm per business day:
 *   1. Build the business window [openMin, closeMin] (minutes from JST midnight).
 *   2. Collect busy intervals that overlap that window, clamped to it.
 *   3. Merge overlapping/adjacent busy intervals.
 *   4. Subtract the merged busy set from the window.
 *   5. Keep gaps whose length >= the minimum duration.
 */

import { toJstWall } from "./ics.js";

/** Weekday codes used by the CLI's --days option. */
export const WEEKDAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

/** A busy interval as absolute epoch ms (end exclusive). */
export interface BusyInterval {
  startMs: number;
  endMs: number;
}

/** Business rules driving the computation. */
export interface BusinessRules {
  /** Inclusive first day, "YYYY-MM-DD" in JST. */
  fromDate: string;
  /** Inclusive last day, "YYYY-MM-DD" in JST. */
  toDate: string;
  /** Minutes from midnight when the business day opens (e.g. 9*60). */
  openMin: number;
  /** Minutes from midnight when the business day closes (e.g. 19*60). */
  closeMin: number;
  /** Set of business weekdays as JS getDay() indexes (0=Sun .. 6=Sat). */
  businessDays: Set<number>;
  /** Minimum free-slot length in minutes. */
  minDurationMin: number;
}

/** A free slot expressed as JST minutes from midnight. */
export interface FreeSlotMinutes {
  startMin: number;
  endMin: number;
}

/** Free slots for a single day. */
export interface DayFreeSlots {
  /** "YYYY-MM-DD" in JST. */
  date: string;
  /** JS getDay() index in JST (0=Sun .. 6=Sat). */
  weekday: number;
  slots: FreeSlotMinutes[];
}

const MS_PER_MINUTE = 60_000;

/** Format a Date's JST date as "YYYY-MM-DD". */
export function jstDateKey(ms: number): string {
  const w = toJstWall(ms);
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Parse a "YYYY-MM-DD" string to its JST-midnight epoch ms. */
export function jstMidnightMs(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`invalid date "${date}" (expected YYYY-MM-DD)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Resolve JST midnight via the offset at noon UTC of that day (stable, JST has
  // no DST so the offset is constant at +9, but we still derive it via Intl).
  return wallToJstInstant(year, month, day, 0, 0);
}

/** Convert JST wall-clock fields to an absolute instant (JST has no DST). */
function wallToJstInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  // Probe the JST offset using a UTC guess, then correct once.
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMin = jstOffsetMinutes(guessUtc);
  return guessUtc - offsetMin * MS_PER_MINUTE;
}

/** JST UTC-offset in minutes at a given instant (derived via Intl, not hardcoded). */
function jstOffsetMinutes(ms: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asUtc - ms) / MS_PER_MINUTE);
}

/** Merge overlapping or adjacent intervals (sorted, in minutes). */
export function mergeIntervals(intervals: FreeSlotMinutes[]): FreeSlotMinutes[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.startMin - b.startMin);
  const merged: FreeSlotMinutes[] = [{ ...(sorted[0] as FreeSlotMinutes) }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i] as FreeSlotMinutes;
    const last = merged[merged.length - 1] as FreeSlotMinutes;
    if (cur.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, cur.endMin);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * Subtract merged busy intervals from [openMin, closeMin] and return gaps that
 * are at least `minDurationMin` long.
 */
export function subtractBusy(
  openMin: number,
  closeMin: number,
  busy: FreeSlotMinutes[],
  minDurationMin: number,
): FreeSlotMinutes[] {
  const merged = mergeIntervals(
    busy
      .map((b) => ({
        startMin: Math.max(openMin, b.startMin),
        endMin: Math.min(closeMin, b.endMin),
      }))
      .filter((b) => b.endMin > b.startMin),
  );

  const free: FreeSlotMinutes[] = [];
  let cursor = openMin;
  for (const b of merged) {
    if (b.startMin > cursor) {
      free.push({ startMin: cursor, endMin: b.startMin });
    }
    cursor = Math.max(cursor, b.endMin);
  }
  if (cursor < closeMin) {
    free.push({ startMin: cursor, endMin: closeMin });
  }

  return free.filter((slot) => slot.endMin - slot.startMin >= minDurationMin);
}

/**
 * Compute per-day free slots for the whole date range. Transparent events must
 * be filtered out by the caller before this point (they are not busy).
 */
export function computeFreeSlots(busy: BusyInterval[], rules: BusinessRules): DayFreeSlots[] {
  if (rules.openMin >= rules.closeMin) {
    throw new Error("business hours: open time must be before close time");
  }

  const fromMs = jstMidnightMs(rules.fromDate);
  const toMs = jstMidnightMs(rules.toDate);
  if (fromMs > toMs) {
    throw new Error("--from date must not be after --to date");
  }

  const result: DayFreeSlots[] = [];
  const dayMs = 24 * 60 * MS_PER_MINUTE;

  for (let dayStart = fromMs; dayStart <= toMs; dayStart += dayMs) {
    const dateKey = jstDateKey(dayStart);
    const weekday = jstWeekday(dayStart);
    if (!rules.businessDays.has(weekday)) continue;

    // Busy intervals as minutes-from-JST-midnight for this specific day.
    const dayOpenMs = dayStart + rules.openMin * MS_PER_MINUTE;
    const dayCloseMs = dayStart + rules.closeMin * MS_PER_MINUTE;
    const busyMinutes: FreeSlotMinutes[] = [];

    for (const b of busy) {
      if (b.endMs <= dayOpenMs || b.startMs >= dayCloseMs) continue;
      // Round conservatively so we never expose free time that overlaps real
      // busy seconds: floor the start (busy may begin earlier in the minute),
      // ceil the end (busy may run later into the minute).
      const startMin = Math.floor((b.startMs - dayStart) / MS_PER_MINUTE);
      const endMin = Math.ceil((b.endMs - dayStart) / MS_PER_MINUTE);
      busyMinutes.push({ startMin, endMin });
    }

    const slots = subtractBusy(rules.openMin, rules.closeMin, busyMinutes, rules.minDurationMin);
    if (slots.length > 0) {
      result.push({ date: dateKey, weekday, slots });
    }
  }

  return result;
}

/** JS getDay() index (0=Sun) for the instant, evaluated in JST. */
export function jstWeekday(ms: number): number {
  // Derive weekday from the JST wall-clock date using a UTC-anchored Date so the
  // host timezone cannot shift it.
  const w = toJstWall(ms);
  const utcNoon = Date.UTC(w.year, w.month - 1, w.day, 12, 0, 0);
  return new Date(utcNoon).getUTCDay();
}
