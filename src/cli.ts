#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import {
  parseIcs,
  computeFreeSlots,
  collectBusyIntervals,
  jstMidnightMs,
  formatSlots,
  toJson,
  WEEKDAY_CODES,
  type WeekdayCode,
  type BusinessRules,
} from "./index.js";

const HELP = `freeslots - find free meeting slots from .ics calendars

Usage:
  freeslots [options] <calendar.ics...>

Reads one or more local iCalendar (.ics) files and prints the FREE meeting
slots within business hours. Fully offline - export an .ics from Google
Calendar (or any calendar app) and pass it in. No API or network is used.

Options:
  --from <YYYY-MM-DD>       Inclusive start date in JST (default: today in Asia/Tokyo)
  --to <YYYY-MM-DD>         Inclusive end date in JST (default: from + 6 days)
  --hours <HH:MM-HH:MM>     Business hours (default: 09:00-19:00)
  --days <list>             Business weekdays, comma list of
                            mon,tue,wed,thu,fri,sat,sun (default: mon,tue,wed,thu,fri)
  --duration <min>          Minimum free-slot length in minutes (default: 30)
  --json                    Output JSON instead of the human format
  -h, --help                Show this help
  -v, --version             Show version

Output (human, one line per day with at least one free slot):
  6/2(火) 13:00〜14:00、15:00〜17:00
  6/3(水) 9:00〜18:00
`;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Today's date as "YYYY-MM-DD" in Asia/Tokyo. */
function todayInTokyo(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Validate a "YYYY-MM-DD" date string. */
function parseDate(name: string, value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`--${name} must be YYYY-MM-DD (got "${value}")`);
  }
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== (m as number) - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new Error(`--${name} is not a valid calendar date (got "${value}")`);
  }
  return value;
}

/** Parse "HH:MM-HH:MM" into open/close minutes-from-midnight. */
function parseHours(value: string): { openMin: number; closeMin: number } {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) {
    throw new Error(`--hours must be HH:MM-HH:MM (got "${value}")`);
  }
  const oh = Number(m[1]);
  const om = Number(m[2]);
  const ch = Number(m[3]);
  const cm = Number(m[4]);
  if (oh > 23 || ch > 24 || om > 59 || cm > 59 || (ch === 24 && cm !== 0)) {
    throw new Error(`--hours has an out-of-range time (got "${value}")`);
  }
  const openMin = oh * 60 + om;
  const closeMin = ch * 60 + cm;
  if (openMin >= closeMin) {
    throw new Error(`--hours open time must be before close time (got "${value}")`);
  }
  return { openMin, closeMin };
}

/** Parse "mon,tue,..." into a set of JS getDay() indexes. */
function parseDays(value: string): Set<number> {
  const codeToIndex: Record<WeekdayCode, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  const set = new Set<number>();
  for (const raw of value.split(",")) {
    const code = raw.trim().toLowerCase() as WeekdayCode;
    if (!WEEKDAY_CODES.includes(code)) {
      throw new Error(
        `--days has an invalid weekday "${raw.trim()}" (use mon,tue,wed,thu,fri,sat,sun)`,
      );
    }
    set.add(codeToIndex[code]);
  }
  if (set.size === 0) {
    throw new Error("--days must list at least one weekday");
  }
  return set;
}

/** Parse a positive integer (minutes). */
function parseDuration(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--duration must be a positive integer number of minutes (got "${value}")`);
  }
  return n;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    process.stdout.write((await readVersion()) + "\n");
    return 0;
  }

  let values;
  let positionals;
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        from: { type: "string" },
        to: { type: "string" },
        hours: { type: "string" },
        days: { type: "string" },
        duration: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  if (positionals.length === 0) {
    process.stderr.write("error: no .ics files given\n\n" + HELP);
    return 1;
  }

  let rules: BusinessRules;
  try {
    const fromDate = values.from ? parseDate("from", values.from) : todayInTokyo();
    const toDate = values.to
      ? parseDate("to", values.to)
      : defaultTo(fromDate);
    const { openMin, closeMin } = values.hours
      ? parseHours(values.hours)
      : { openMin: 9 * 60, closeMin: 19 * 60 };
    const businessDays = values.days
      ? parseDays(values.days)
      : new Set([1, 2, 3, 4, 5]);
    const minDurationMin = values.duration ? parseDuration(values.duration) : 30;

    rules = { fromDate, toDate, openMin, closeMin, businessDays, minDurationMin };
    if (jstMidnightMs(fromDate) > jstMidnightMs(toDate)) {
      throw new Error("--from date must not be after --to date");
    }
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  // Read and merge all calendars.
  const allEvents = [];
  for (const path of positionals) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      process.stderr.write(`error: cannot read .ics file "${path}"\n`);
      return 1;
    }
    try {
      allEvents.push(...parseIcs(text));
    } catch (err) {
      process.stderr.write(`error: failed to parse "${path}": ${(err as Error).message}\n`);
      return 1;
    }
  }

  // The query window spans whole JST days from `from` through `to` inclusive.
  const windowStartMs = jstMidnightMs(rules.fromDate);
  const windowEndMs = jstMidnightMs(rules.toDate) + MS_PER_DAY;

  const { busy, unsupportedRecurrence } = collectBusyIntervals(
    allEvents,
    windowStartMs,
    windowEndMs,
  );

  if (unsupportedRecurrence > 0) {
    process.stderr.write(
      `note: skipped ${unsupportedRecurrence} event(s) with unsupported recurrence rules\n`,
    );
  }

  const days = computeFreeSlots(busy, rules);

  if (values.json) {
    process.stdout.write(JSON.stringify(toJson(days), null, 2) + "\n");
  } else {
    const out = formatSlots(days);
    process.stdout.write(out.length > 0 ? out + "\n" : "");
  }

  return 0;
}

/** Default --to is --from plus 6 days (a 7-day window). */
function defaultTo(fromDate: string): string {
  const [y, m, d] = fromDate.split("-").map(Number);
  const end = new Date(Date.UTC(y as number, (m as number) - 1, d as number) + 6 * MS_PER_DAY);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`;
}

async function readVersion(): Promise<string> {
  const { fileURLToPath } = await import("node:url");
  const { join, dirname } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    const raw = await readFile(join(here, "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
