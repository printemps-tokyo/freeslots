/**
 * Pure multi-person overlap analysis. Given each person's busy intervals, find
 * the slots where at least `require` of them are free, broken so that within a
 * slot the set of busy people is constant (and annotated with who is busy).
 *
 * The default `require = people.length` reproduces the single-calendar
 * "everyone free" behavior; a smaller value finds partial-overlap windows.
 */
import type { BusyInterval, BusinessRules } from "./freeslots.js";
import { jstDateKey, jstMidnightMs, jstWeekday } from "./freeslots.js";
import { formatTime, WEEKDAY_CHARS } from "./format.js";

const MS_PER_MINUTE = 60_000;

export interface OverlapSlot {
  startMin: number;
  endMin: number;
  /** Labels of the people who are BUSY during this slot (empty = everyone free). */
  busy: string[];
}

export interface DayOverlapSlots {
  date: string;
  weekday: number;
  slots: OverlapSlot[];
}

function busyAt(intervals: BusyInterval[], startMs: number, endMs: number): boolean {
  return intervals.some((b) => b.startMs < endMs && b.endMs > startMs);
}

/**
 * Compute overlap slots. `busyPerPerson[i]` is person i's busy intervals (epoch
 * ms); `names[i]` labels them. Resolution is one minute (a business day is
 * small, so this stays cheap and simple).
 */
export function computeOverlapSlots(
  busyPerPerson: BusyInterval[][],
  names: string[],
  rules: BusinessRules,
  require: number,
): DayOverlapSlots[] {
  const n = busyPerPerson.length;
  const fromMs = jstMidnightMs(rules.fromDate);
  const toMs = jstMidnightMs(rules.toDate);
  const dayMs = 24 * 60 * MS_PER_MINUTE;
  const result: DayOverlapSlots[] = [];

  for (let dayStart = fromMs; dayStart <= toMs; dayStart += dayMs) {
    const dateKey = jstDateKey(dayStart);
    const weekday = jstWeekday(dayStart);
    if (!rules.businessDays.has(weekday)) continue;
    if (rules.holidays?.has(dateKey)) continue;

    const slots: OverlapSlot[] = [];
    let runStart = -1;
    let runKey = "";
    let runBusy: number[] = [];

    const flush = (endMin: number): void => {
      if (runStart >= 0 && endMin - runStart >= rules.minDurationMin) {
        slots.push({
          startMin: runStart,
          endMin,
          busy: runBusy.map((i) => names[i] ?? `calendar ${i + 1}`),
        });
      }
      runStart = -1;
    };

    for (let m = rules.openMin; m < rules.closeMin; m++) {
      const minStart = dayStart + m * MS_PER_MINUTE;
      const minEnd = minStart + MS_PER_MINUTE;
      const busy: number[] = [];
      for (let p = 0; p < n; p++) {
        if (busyAt(busyPerPerson[p] as BusyInterval[], minStart, minEnd)) busy.push(p);
      }
      const available = n - busy.length >= require;
      if (!available) {
        flush(m);
        continue;
      }
      const key = busy.join(",");
      if (runStart < 0) {
        runStart = m;
        runKey = key;
        runBusy = busy;
      } else if (key !== runKey) {
        flush(m);
        runStart = m;
        runKey = key;
        runBusy = busy;
      }
    }
    flush(rules.closeMin);

    if (slots.length > 0) result.push({ date: dateKey, weekday, slots });
  }
  return result;
}

const WAVE_DASH = "〜";
const IDEOGRAPHIC_COMMA = "、";

function monthDay(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${Number(m[2])}/${Number(m[3])}` : date;
}

/** Format one day's overlap slots, annotating busy people as "(X不可)". */
export function formatOverlapDayLine(day: DayOverlapSlots): string {
  const ranges = day.slots
    .map((s) => {
      const range = `${formatTime(s.startMin)}${WAVE_DASH}${formatTime(s.endMin)}`;
      return s.busy.length > 0 ? `${range}(${s.busy.join("・")}不可)` : range;
    })
    .join(IDEOGRAPHIC_COMMA);
  const weekday = WEEKDAY_CHARS[day.weekday] ?? "";
  return `${monthDay(day.date)}(${weekday}) ${ranges}`;
}

/** Format all overlap days as the human output. */
export function formatOverlapSlots(days: DayOverlapSlots[]): string {
  return days.map(formatOverlapDayLine).join("\n");
}

/** JSON entry for an overlap day. */
export interface JsonOverlapDay {
  date: string;
  weekday: string;
  slots: { start: string; end: string; busy: string[] }[];
}

export function toJsonOverlap(days: DayOverlapSlots[]): JsonOverlapDay[] {
  return days.map((day) => ({
    date: day.date,
    weekday: WEEKDAY_CHARS[day.weekday] ?? "",
    slots: day.slots.map((s) => ({
      start: formatTime(s.startMin),
      end: formatTime(s.endMin),
      busy: s.busy,
    })),
  }));
}
