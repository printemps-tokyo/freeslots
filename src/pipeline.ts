/**
 * Pure glue between parsing/recurrence and the free-slot engine.
 *
 * Turns parsed events into the set of busy intervals for a query window:
 *   - expands recurrence (counting unsupported rules),
 *   - drops transparent (free) events,
 *   - keeps only the opaque (busy) instances overlapping the window.
 */

import { toJstWall, type IcsEvent } from "./ics.js";
import { expandEvent } from "./recurrence.js";
import type { BusyInterval } from "./freeslots.js";

export interface CollectResult {
  busy: BusyInterval[];
  /** Count of events skipped due to unsupported recurrence rules. */
  unsupportedRecurrence: number;
}

/**
 * Collect busy intervals from events within [windowStartMs, windowEndMs).
 * Transparent events never contribute. Zero-length intervals are dropped.
 */
export function collectBusyIntervals(
  events: IcsEvent[],
  windowStartMs: number,
  windowEndMs: number,
): CollectResult {
  const busy: BusyInterval[] = [];
  let unsupportedRecurrence = 0;

  for (const event of events) {
    const expanded = expandEvent(event, windowStartMs, windowEndMs);
    if (expanded.unsupported) {
      unsupportedRecurrence++;
      continue;
    }
    for (const instance of expanded.instances) {
      if (instance.transparent) continue;
      if (instance.endMs <= instance.startMs) continue; // zero-length blocks nothing
      if (instance.endMs <= windowStartMs || instance.startMs >= windowEndMs) continue;
      busy.push({ startMs: instance.startMs, endMs: instance.endMs });
    }
  }

  return { busy, unsupportedRecurrence };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The JST dates (YYYY-MM-DD) covered by all-day events within the window,
 * for treating a holiday calendar's days as days off. Holiday feeds mark
 * their events transparent (they block no time), so transparency is not
 * looked at here; timed events are ignored.
 */
export function allDayDates(events: IcsEvent[], windowStartMs: number, windowEndMs: number): Set<string> {
  const dates = new Set<string>();
  for (const event of events) {
    const { instances } = expandEvent(event, windowStartMs, windowEndMs);
    for (const instance of instances) {
      if (!instance.allDay) continue;
      // All-day instants are JST midnights; step a day at a time.
      for (let t = instance.startMs; t < instance.endMs; t += MS_PER_DAY) {
        if (t + MS_PER_DAY <= windowStartMs || t >= windowEndMs) continue;
        const w = toJstWall(t);
        dates.add(`${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`);
      }
    }
  }
  return dates;
}
