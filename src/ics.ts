/**
 * Pure iCalendar (.ics) parsing helpers (RFC 5545 subset).
 *
 * This module is intentionally side-effect free: it takes raw .ics text and
 * returns plain event objects. No file I/O, no network, no Google Calendar API.
 *
 * Timezone strategy
 * -----------------
 * All output of `freeslots` is in Asia/Tokyo. To map an absolute instant to
 * Tokyo wall-clock fields we use `Intl.DateTimeFormat` with
 * `timeZone: "Asia/Tokyo"` and `formatToParts`. We never hardcode a "+9" offset
 * so the implementation stays correct regardless of host timezone.
 *
 * DTSTART/DTEND forms handled:
 *   - UTC instant:        DTSTART:20240602T040000Z
 *   - floating local:     DTSTART:20240602T130000        (no zone -> treated as JST wall-clock)
 *   - zoned:              DTSTART;TZID=Asia/Tokyo:20240602T130000
 *                         DTSTART;TZID=America/New_York:20240601T230000
 *   - date-only/all-day:  DTSTART;VALUE=DATE:20240602
 */

/** A wall-clock instant expressed in Asia/Tokyo fields. */
export interface JstWall {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
}

/** A parsed VEVENT, normalised for free-slot computation. */
export interface IcsEvent {
  /** Absolute start instant in epoch ms (always resolvable for timed events). */
  startMs: number;
  /** Absolute end instant in epoch ms (exclusive). */
  endMs: number;
  /** Whether this is an all-day (VALUE=DATE) event. */
  allDay: boolean;
  /** TRANSP:TRANSPARENT events are "free" and never block time. */
  transparent: boolean;
  /** Raw RRULE value, if present (e.g. "FREQ=WEEKLY;BYDAY=MO,WE"). */
  rrule?: string;
  /** EXDATE instants as epoch ms (start instants to exclude from expansion). */
  exdates: number[];
}

/** A single raw "NAME;PARAM=x:VALUE" content line after unfolding. */
interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

const MS_PER_MINUTE = 60_000;

/**
 * Unfold RFC 5545 folded lines. Continuation lines begin with a single space
 * or horizontal tab; that leading whitespace is removed and the line is joined
 * to the previous one. Handles both CRLF and LF endings.
 */
export function unfoldLines(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Parse one unfolded content line into name, parameters and value. */
function parseContentLine(line: string): ContentLine | undefined {
  const colon = line.indexOf(":");
  if (colon === -1) return undefined;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  const parts = head.split(";");
  const name = (parts[0] ?? "").toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i] ?? "";
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }
  return { name, params, value };
}

/**
 * Map an absolute instant to Asia/Tokyo wall-clock fields using Intl
 * (no hardcoded offset).
 */
export function toJstWall(ms: number): JstWall {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  let hour = get("hour");
  // Intl can emit hour "24" at midnight with hour12:false; normalise to 0.
  if (hour === 24) hour = 0;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
  };
}

/**
 * Compute the UTC offset (in minutes) that a given IANA timezone has at a
 * particular instant, via the standard Intl formatToParts technique: format the
 * instant in that zone, read the wall-clock fields back as if they were UTC, and
 * take the difference from the true instant.
 */
function zoneOffsetMinutes(ms: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - ms) / MS_PER_MINUTE);
}

/**
 * Resolve wall-clock fields in a named IANA timezone to an absolute instant.
 * Iterates once to settle DST boundaries (offset can depend on the instant).
 */
export function wallTimeToInstant(
  timeZone: string,
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  // First guess: treat the wall time as if it were UTC.
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  // Refine twice using the zone offset at the guessed instant.
  for (let i = 0; i < 2; i++) {
    const offset = zoneOffsetMinutes(guess, timeZone);
    const next = Date.UTC(year, month - 1, day, hour, minute, second) - offset * MS_PER_MINUTE;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/**
 * Convert Asia/Tokyo wall-clock fields to an absolute instant. JST has no DST,
 * but the offset is still derived via Intl (not hardcoded) for consistency.
 */
export function jstWallToInstant(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second = 0,
): number {
  return wallTimeToInstant("Asia/Tokyo", year, month, day, hour, minute, second);
}

/**
 * Parse an RFC 5545 DURATION value into milliseconds.
 *
 * Supports weeks (`P1W`), days, hours, minutes and seconds in the
 * `P[n]W` / `P[n]DT[n]H[n]M[n]S` grammar (e.g. `PT1H`, `PT1H30M`, `P1D`,
 * `P1DT2H`, `PT0S`). A leading `-` (or a zero/negative total) is treated as
 * zero-length, since a negative busy interval blocks no time. Returns 0 for
 * unparseable values.
 */
export function parseIcsDuration(value: string): number {
  const trimmed = value.trim();
  const m = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(trimmed);
  if (!m) return 0;
  // Reject "P" with no components at all (and stray "PT" with nothing after).
  if (!m[2] && !m[3] && !m[4] && !m[5] && !m[6]) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const weeks = Number(m[2] ?? 0);
  const days = Number(m[3] ?? 0);
  const hours = Number(m[4] ?? 0);
  const minutes = Number(m[5] ?? 0);
  const seconds = Number(m[6] ?? 0);
  const totalMs =
    sign *
    (weeks * 7 * 24 * 60 * 60 + days * 24 * 60 * 60 + hours * 60 * 60 + minutes * 60 + seconds) *
    1000;
  // Negative / zero durations block no time.
  return totalMs > 0 ? totalMs : 0;
}

interface ParsedDateTime {
  ms: number;
  allDay: boolean;
}

/** Parse a DTSTART/DTEND value with its parameters into an absolute instant. */
function parseDateTime(value: string, params: Record<string, string>): ParsedDateTime | undefined {
  const isDateOnly = (params.VALUE ?? "").toUpperCase() === "DATE" || /^\d{8}$/.test(value);

  if (isDateOnly) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!m) return undefined;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    // An all-day date is anchored to JST midnight of that calendar day.
    const ms = wallTimeToInstant("Asia/Tokyo", year, month, day, 0, 0, 0);
    return { ms, allDay: true };
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const isUtc = m[7] === "Z";

  if (isUtc) {
    return { ms: Date.UTC(year, month - 1, day, hour, minute, second), allDay: false };
  }

  const tzid = params.TZID;
  if (tzid) {
    // Resolve in the named zone (covers TZID=Asia/Tokyo and other zones).
    const ms = wallTimeToInstant(tzid, year, month, day, hour, minute, second);
    return { ms, allDay: false };
  }

  // Floating time: treat as JST wall-clock directly.
  const ms = wallTimeToInstant("Asia/Tokyo", year, month, day, hour, minute, second);
  return { ms, allDay: false };
}

/**
 * Parse .ics text into normalised events. Events without a resolvable DTSTART
 * are skipped. Events with no DTEND default to a zero-length interval (which is
 * effectively "free" since it blocks no time).
 */
export function parseIcs(text: string): IcsEvent[] {
  const lines = unfoldLines(text);
  const events: IcsEvent[] = [];

  let inEvent = false;
  let startMs: number | undefined;
  let endMs: number | undefined;
  let durationMs: number | undefined;
  let allDay = false;
  let transparent = false;
  let rrule: string | undefined;
  let exdates: number[] = [];

  for (const line of lines) {
    const parsed = parseContentLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;

    if (name === "BEGIN" && value === "VEVENT") {
      inEvent = true;
      startMs = undefined;
      endMs = undefined;
      durationMs = undefined;
      allDay = false;
      transparent = false;
      rrule = undefined;
      exdates = [];
      continue;
    }

    if (name === "END" && value === "VEVENT") {
      if (inEvent && startMs !== undefined) {
        let resolvedEnd = endMs;
        if (resolvedEnd === undefined) {
          if (durationMs !== undefined) {
            // No DTEND but a DURATION is present: end = start + duration.
            resolvedEnd = startMs + durationMs;
          } else {
            // Neither DTEND nor DURATION: all-day -> one full day; timed -> zero.
            resolvedEnd = allDay ? startMs + 24 * 60 * MS_PER_MINUTE : startMs;
          }
        }
        events.push({
          startMs,
          endMs: resolvedEnd,
          allDay,
          transparent,
          rrule,
          exdates,
        });
      }
      inEvent = false;
      continue;
    }

    if (!inEvent) continue;

    switch (name) {
      case "DTSTART": {
        const dt = parseDateTime(value, params);
        if (dt) {
          startMs = dt.ms;
          allDay = dt.allDay;
        }
        break;
      }
      case "DTEND": {
        const dt = parseDateTime(value, params);
        if (dt) endMs = dt.ms;
        break;
      }
      case "DURATION":
        durationMs = parseIcsDuration(value);
        break;
      case "TRANSP":
        transparent = value.trim().toUpperCase() === "TRANSPARENT";
        break;
      case "RRULE":
        rrule = value.trim();
        break;
      case "EXDATE": {
        for (const piece of value.split(",")) {
          const dt = parseDateTime(piece.trim(), params);
          if (dt) exdates.push(dt.ms);
        }
        break;
      }
      default:
        break;
    }
  }

  return events;
}
