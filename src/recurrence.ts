/**
 * Pure RRULE expansion (a deliberately small subset of RFC 5545).
 *
 * Supported:
 *   - FREQ=DAILY  with optional INTERVAL, COUNT, UNTIL
 *   - FREQ=WEEKLY with optional INTERVAL, COUNT, UNTIL, BYDAY
 *   - EXDATE exclusions (matched on the event start instant)
 *
 * Anything else (FREQ=MONTHLY/YEARLY, BYMONTHDAY, BYSETPOS, etc.) is reported
 * as unsupported so the caller can skip it and surface a note, rather than
 * silently dropping events.
 */

import type { IcsEvent } from "./ics.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** RFC 5545 BYDAY two-letter codes mapped to JS getUTCDay() indexes (0=Sun). */
const BYDAY_TO_DOW: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

interface ParsedRule {
  freq: "DAILY" | "WEEKLY";
  interval: number;
  count?: number;
  untilMs?: number;
  byDay?: number[];
}

/** Parse an RRULE value into a structured rule, or null if unsupported. */
export function parseRrule(rrule: string): ParsedRule | null {
  const parts: Record<string, string> = {};
  for (const seg of rrule.split(";")) {
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    parts[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }

  const freq = (parts.FREQ ?? "").toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY") return null;

  // Reject rule parts we do not implement to avoid producing wrong results.
  const unsupportedKeys = [
    "BYMONTHDAY",
    "BYMONTH",
    "BYYEARDAY",
    "BYWEEKNO",
    "BYSETPOS",
    "BYHOUR",
    "BYMINUTE",
  ];
  for (const key of unsupportedKeys) {
    if (parts[key] !== undefined) return null;
  }

  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;

  let count: number | undefined;
  if (parts.COUNT !== undefined) {
    count = Number(parts.COUNT);
    if (!Number.isInteger(count) || count < 1) return null;
  }

  let untilMs: number | undefined;
  if (parts.UNTIL !== undefined) {
    untilMs = parseUntil(parts.UNTIL);
    if (untilMs === undefined) return null;
  }

  let byDay: number[] | undefined;
  if (parts.BYDAY !== undefined) {
    byDay = [];
    for (const token of parts.BYDAY.split(",")) {
      const code = token.trim().toUpperCase();
      // Positional BYDAY like "2MO" is not supported in this subset.
      if (!(code in BYDAY_TO_DOW)) return null;
      byDay.push(BYDAY_TO_DOW[code] as number);
    }
  }

  return { freq, interval, count, untilMs, byDay };
}

/** Parse an UNTIL value (date or date-time, UTC or floating) to epoch ms. */
function parseUntil(value: string): number | undefined {
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value);
  if (dt) {
    return Date.UTC(
      Number(dt[1]),
      Number(dt[2]) - 1,
      Number(dt[3]),
      Number(dt[4]),
      Number(dt[5]),
      Number(dt[6]),
    );
  }
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (d) {
    // Inclusive through the end of that UTC day.
    return Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), 23, 59, 59);
  }
  return undefined;
}

export interface ExpandResult {
  /** Concrete, non-recurring event instances within the window. */
  instances: IcsEvent[];
  /** True if the event had an RRULE we could not expand (caller should note it). */
  unsupported: boolean;
}

/**
 * Expand one event into concrete instances overlapping [windowStartMs, windowEndMs).
 * Non-recurring events pass through unchanged. Unsupported RRULEs yield
 * `unsupported: true` and no instances.
 */
export function expandEvent(
  event: IcsEvent,
  windowStartMs: number,
  windowEndMs: number,
): ExpandResult {
  if (!event.rrule) {
    return { instances: [event], unsupported: false };
  }

  const rule = parseRrule(event.rrule);
  if (!rule) {
    return { instances: [], unsupported: true };
  }

  const durationMs = event.endMs - event.startMs;
  const stepDays = rule.freq === "DAILY" ? rule.interval : 7 * rule.interval;
  const exclude = new Set(event.exdates);
  const instances: IcsEvent[] = [];

  // Safety cap to bound iteration regardless of malformed rules.
  const MAX_ITERATIONS = 10_000;
  let emitted = 0;

  if (rule.freq === "WEEKLY" && rule.byDay && rule.byDay.length > 0) {
    // Anchor to UTC midnight of the (Sunday-started) week containing DTSTART,
    // then add each requested weekday plus the original time-of-day.
    const baseDow = new Date(event.startMs).getUTCDay();
    const timeOfDay = timeOfDayMs(event.startMs);
    const weekStartMidnight = event.startMs - timeOfDay - baseDow * MS_PER_DAY;
    const wantDows = new Set(rule.byDay);

    for (let w = 0, iter = 0; iter < MAX_ITERATIONS; w += rule.interval, iter++) {
      const weekBase = weekStartMidnight + w * 7 * MS_PER_DAY;
      if (weekBase > windowEndMs && weekBase > (rule.untilMs ?? Infinity)) break;
      let stop = false;
      for (let dow = 0; dow < 7; dow++) {
        if (!wantDows.has(dow)) continue;
        const start = weekBase + dow * MS_PER_DAY + timeOfDay;
        if (start < event.startMs) continue; // never emit before DTSTART
        if (rule.untilMs !== undefined && start > rule.untilMs) {
          stop = true;
          break;
        }
        if (rule.count !== undefined && emitted >= rule.count) {
          stop = true;
          break;
        }
        emitted++;
        if (start + durationMs <= windowStartMs || start >= windowEndMs) continue;
        if (exclude.has(start)) continue;
        instances.push(makeInstance(event, start, durationMs));
      }
      if (stop) break;
    }
    return { instances, unsupported: false };
  }

  // DAILY, or WEEKLY without BYDAY (every `interval` weeks on DTSTART's weekday).
  for (let i = 0, iter = 0; iter < MAX_ITERATIONS; i++, iter++) {
    const start = event.startMs + i * stepDays * MS_PER_DAY;
    if (rule.count !== undefined && emitted >= rule.count) break;
    if (rule.untilMs !== undefined && start > rule.untilMs) break;
    if (start >= windowEndMs && rule.count === undefined) break;
    emitted++;
    if (start + durationMs <= windowStartMs || start >= windowEndMs) continue;
    if (exclude.has(start)) continue;
    instances.push(makeInstance(event, start, durationMs));
  }

  return { instances, unsupported: false };
}

/** Milliseconds since UTC midnight for an instant (used to preserve time-of-day). */
function timeOfDayMs(ms: number): number {
  return ((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
}

function makeInstance(base: IcsEvent, startMs: number, durationMs: number): IcsEvent {
  return {
    startMs,
    endMs: startMs + durationMs,
    allDay: base.allDay,
    transparent: base.transparent,
    exdates: [],
  };
}
