/**
 * Pure glue between parsing/recurrence and the free-slot engine.
 *
 * Turns parsed events into the set of busy intervals for a query window:
 *   - expands recurrence (counting unsupported rules),
 *   - drops transparent (free) events,
 *   - keeps only the opaque (busy) instances overlapping the window.
 */

import type { IcsEvent } from "./ics.js";
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
