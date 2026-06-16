/**
 * Pure RRULE expansion (a deliberately small subset of RFC 5545).
 *
 * Supported:
 *   - FREQ=DAILY   with optional INTERVAL, COUNT, UNTIL, BYDAY
 *   - FREQ=WEEKLY  with optional INTERVAL, COUNT, UNTIL, BYDAY
 *   - FREQ=MONTHLY with optional INTERVAL, COUNT, UNTIL, BYMONTHDAY
 *   - EXDATE exclusions (matched by JST calendar day)
 *
 * Anything else (FREQ=YEARLY, positional BYDAY like "2MO", BYSETPOS, etc.) is
 * reported as unsupported so the caller can skip it and surface a note, rather
 * than silently dropping events.
 *
 * Timezone strategy
 * -----------------
 * All bucketing is Asia/Tokyo (JST = UTC+9, no DST). Weekly/daily anchoring,
 * BYDAY matching and EXDATE exclusion are all computed against JST wall-clock so
 * recurrences land on the correct JST day regardless of the host timezone.
 */

import type { IcsEvent } from "./ics.js";
import { jstWallToInstant, toJstWall } from "./ics.js";
import { jstDateKey, jstWeekday } from "./freeslots.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** RFC 5545 BYDAY two-letter codes mapped to JST weekday indexes (0=Sun). */
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
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  count?: number;
  untilMs?: number;
  byDay?: number[];
  byMonthDay?: number[];
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
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") return null;

  // Reject rule parts we do not implement to avoid producing wrong results.
  const unsupportedKeys = ["BYMONTH", "BYYEARDAY", "BYWEEKNO", "BYSETPOS", "BYHOUR", "BYMINUTE"];
  for (const key of unsupportedKeys) {
    if (parts[key] !== undefined) return null;
  }

  // BYMONTHDAY is only meaningful (and only implemented) for MONTHLY.
  let byMonthDay: number[] | undefined;
  if (parts.BYMONTHDAY !== undefined) {
    if (freq !== "MONTHLY") return null;
    byMonthDay = [];
    for (const token of parts.BYMONTHDAY.split(",")) {
      const n = Number(token.trim());
      // Only positive day-of-month is supported (negative offsets like -1 not).
      if (!Number.isInteger(n) || n < 1 || n > 31) return null;
      byMonthDay.push(n);
    }
  }

  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;

  // WKST only affects how multi-week (INTERVAL>1) weekly rules group days. We do
  // not implement a configurable week start, so a non-default WKST with
  // INTERVAL>1 weekly is reported unsupported rather than expanded incorrectly.
  // INTERVAL==1 is unaffected by WKST, so it is allowed.
  if (parts.WKST !== undefined && freq === "WEEKLY" && interval > 1) {
    return null;
  }

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
    // MONTHLY+BYDAY needs positional handling ("2MO"), which is unsupported.
    if (freq === "MONTHLY") return null;
    byDay = [];
    for (const token of parts.BYDAY.split(",")) {
      const code = token.trim().toUpperCase();
      // Positional BYDAY like "2MO" is not supported in this subset.
      if (!(code in BYDAY_TO_DOW)) return null;
      byDay.push(BYDAY_TO_DOW[code] as number);
    }
  }

  return { freq, interval, count, untilMs, byDay, byMonthDay };
}

/**
 * Parse an UNTIL value to an inclusive epoch-ms bound, interpreted in the zone
 * that matches the value form. Output bucketing is JST, so:
 *   - `...Z` (UTC date-time)  -> exact UTC instant.
 *   - floating date-time      -> JST wall-clock instant.
 *   - date-only `YYYYMMDD`    -> end of that JST calendar day.
 */
function parseUntil(value: string): number | undefined {
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (dt) {
    const year = Number(dt[1]);
    const month = Number(dt[2]);
    const day = Number(dt[3]);
    const hour = Number(dt[4]);
    const minute = Number(dt[5]);
    const second = Number(dt[6]);
    if (dt[7] === "Z") {
      return Date.UTC(year, month - 1, day, hour, minute, second);
    }
    // Floating UNTIL: interpret in JST.
    return jstWallToInstant(year, month, day, hour, minute, second);
  }
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (d) {
    // Date-only UNTIL: inclusive through the end of that JST day.
    return jstWallToInstant(Number(d[1]), Number(d[2]), Number(d[3]), 23, 59, 59);
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
  // EXDATE is matched by JST calendar day. This excludes the whole JST day,
  // which is correct for the one-occurrence-per-day DAILY/WEEKLY rules we
  // support. Exact-instant exclusion is kept as a fast path too.
  const excludeMs = new Set(event.exdates);
  const excludeDays = new Set(event.exdates.map((ms) => jstDateKey(ms)));
  const instances: IcsEvent[] = [];

  // Safety cap to bound iteration regardless of malformed rules.
  const MAX_ITERATIONS = 10_000;
  let emitted = 0;

  const isExcluded = (start: number): boolean =>
    excludeMs.has(start) || excludeDays.has(jstDateKey(start));

  if (rule.freq === "WEEKLY" && rule.byDay && rule.byDay.length > 0) {
    // Anchor the week in JST wall-clock: find JST midnight of the (Sunday-started)
    // week containing DTSTART, then add each requested JST weekday plus the
    // original JST time-of-day, converting each candidate back to an instant.
    const startWall = toJstWall(event.startMs);
    const baseDow = jstWeekday(event.startMs);
    // JST midnight of DTSTART's calendar day.
    const startMidnight = jstWallToInstant(
      startWall.year,
      startWall.month,
      startWall.day,
      0,
      0,
      0,
    );
    // JST midnight of the Sunday that begins DTSTART's week.
    const weekStartMidnight = startMidnight - baseDow * MS_PER_DAY;
    const wantDows = new Set(rule.byDay);

    // Fast-forward unbounded rules so iteration starts near the window instead
    // of at week 0 (which may be years earlier). COUNT rules must count from
    // occurrence 0, so they are not fast-forwarded.
    let startWeek = 0;
    if (rule.count === undefined && weekStartMidnight < windowStartMs) {
      const weeksElapsed = Math.floor((windowStartMs - weekStartMidnight) / (7 * MS_PER_DAY));
      // Snap down to a multiple of INTERVAL and back off one interval for safety.
      startWeek = Math.max(0, Math.floor(weeksElapsed / rule.interval - 1) * rule.interval);
    }

    for (let w = startWeek, iter = 0; iter < MAX_ITERATIONS; w += rule.interval, iter++) {
      // Approximate week base; +9h slack keeps the overshoot check JST-safe.
      const weekBaseApprox = weekStartMidnight + w * 7 * MS_PER_DAY;
      // Once the whole week starts after the window end, no later day in this or
      // any subsequent week can land in the window, so stop. (COUNT only limits
      // how many we emit; it cannot pull an in-window instance from later.)
      if (weekBaseApprox >= windowEndMs) break;
      let stop = false;
      for (let dow = 0; dow < 7; dow++) {
        if (!wantDows.has(dow)) continue;
        // Candidate JST calendar day = week's Sunday + dow days. Recompute its
        // JST wall-clock and resolve the original time-of-day to an instant so
        // it is exact regardless of host timezone.
        const dayWall = toJstWall(weekBaseApprox + dow * MS_PER_DAY + 12 * 60 * 60 * 1000);
        const start = jstWallToInstant(
          dayWall.year,
          dayWall.month,
          dayWall.day,
          startWall.hour,
          startWall.minute,
          0,
        );
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
        if (isExcluded(start)) continue;
        instances.push(makeInstance(event, start, durationMs));
      }
      if (stop) break;
    }
    return { instances, unsupported: false };
  }

  if (rule.freq === "MONTHLY") {
    // Anchor in JST: step by `interval` months from DTSTART's month, emitting an
    // instance on each target day-of-month (BYMONTHDAY, or DTSTART's day) at the
    // original JST time-of-day. Days that do not exist in a month (e.g. the 31st
    // of February) are simply skipped per RFC 5545.
    const startWall = toJstWall(event.startMs);
    const targetDays =
      rule.byMonthDay && rule.byMonthDay.length > 0
        ? [...rule.byMonthDay].sort((a, b) => a - b)
        : [startWall.day];

    // Fast-forward unbounded rules to near the window (COUNT counts from 0).
    let startMonth = 0;
    if (rule.count === undefined && event.startMs < windowStartMs) {
      const winWall = toJstWall(windowStartMs);
      const monthsDiff =
        winWall.year * 12 + (winWall.month - 1) - (startWall.year * 12 + (startWall.month - 1));
      if (monthsDiff > 0) {
        startMonth = Math.max(0, Math.floor(monthsDiff / rule.interval - 1) * rule.interval);
      }
    }

    for (let mi = startMonth, iter = 0; iter < MAX_ITERATIONS; mi += rule.interval, iter++) {
      const total = startWall.month - 1 + mi;
      const year = startWall.year + Math.floor(total / 12);
      const month = (total % 12) + 1; // 1-based
      // If the whole month begins after the window, no later month can land in it.
      if (jstWallToInstant(year, month, 1, 0, 0, 0) >= windowEndMs) break;
      const dim = daysInMonth(year, month);
      let stop = false;
      for (const day of targetDays) {
        if (day > dim) continue; // invalid date in this month -> not an occurrence
        const start = jstWallToInstant(year, month, day, startWall.hour, startWall.minute, 0);
        if (start < event.startMs) continue;
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
        if (isExcluded(start)) continue;
        instances.push(makeInstance(event, start, durationMs));
      }
      if (stop) break;
    }
    return { instances, unsupported: false };
  }

  // DAILY (optionally filtered by BYDAY), or WEEKLY without BYDAY (every
  // `interval` weeks on DTSTART's weekday).
  const stepDays = rule.freq === "DAILY" ? rule.interval : 7 * rule.interval;
  const byDayFilter =
    rule.freq === "DAILY" && rule.byDay && rule.byDay.length > 0
      ? new Set(rule.byDay)
      : undefined;

  // Fast-forward unbounded rules to begin iterating near the window. COUNT rules
  // must count from occurrence 0, so they keep startIndex 0.
  let startIndex = 0;
  if (rule.count === undefined && event.startMs < windowStartMs) {
    const elapsed = Math.floor((windowStartMs - event.startMs) / (stepDays * MS_PER_DAY));
    startIndex = Math.max(0, elapsed - 1);
  }

  for (let i = startIndex, iter = 0; iter < MAX_ITERATIONS; i++, iter++) {
    // Step in whole JST days: take JST midnight of DTSTART, add whole days, then
    // reapply the original JST time-of-day. (JST has no DST, but this keeps the
    // arithmetic consistent with the rest of the engine.)
    const start = event.startMs + i * stepDays * MS_PER_DAY;
    if (rule.count !== undefined && emitted >= rule.count) break;
    if (rule.untilMs !== undefined && start > rule.untilMs) break;
    if (start >= windowEndMs && rule.count === undefined) break;
    if (byDayFilter && !byDayFilter.has(jstWeekday(start))) {
      // DAILY+BYDAY: only the listed JST weekdays count as occurrences. This is
      // not a COUNT-bearing occurrence, so do not increment `emitted`.
      continue;
    }
    emitted++;
    if (start + durationMs <= windowStartMs || start >= windowEndMs) continue;
    if (isExcluded(start)) continue;
    instances.push(makeInstance(event, start, durationMs));
  }

  return { instances, unsupported: false };
}

/** Number of days in a 1-based month of a given year. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
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
