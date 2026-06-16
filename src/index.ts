/**
 * Public API for freeslots.
 *
 * `freeslots` finds free meeting slots from local iCalendar (.ics) files. It is
 * fully offline: it parses .ics text and never calls any calendar API.
 */

export { parseIcs, unfoldLines, toJstWall } from "./ics.js";
export type { IcsEvent, JstWall } from "./ics.js";

export { parseRrule, expandEvent } from "./recurrence.js";
export type { ExpandResult } from "./recurrence.js";

export {
  computeFreeSlots,
  mergeIntervals,
  subtractBusy,
  jstMidnightMs,
  jstWeekday,
  WEEKDAY_CODES,
} from "./freeslots.js";
export type {
  BusyInterval,
  BusinessRules,
  FreeSlotMinutes,
  DayFreeSlots,
  WeekdayCode,
} from "./freeslots.js";

export { formatSlots, formatDayLine, formatTime, toJson, WEEKDAY_CHARS } from "./format.js";
export type { JsonDay } from "./format.js";

export { collectBusyIntervals } from "./pipeline.js";
export type { CollectResult } from "./pipeline.js";

export { buildIcs, utcStamp, jstWallToUtcStamp } from "./ics-export.js";
export type { IcsOptions } from "./ics-export.js";
