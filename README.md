# freeslots

> Find free meeting slots from .ics calendars. Zero-dependency CLI.

[![CI](https://github.com/printemps-tokyo/freeslots/actions/workflows/ci.yml/badge.svg)](https://github.com/printemps-tokyo/freeslots/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

`freeslots` reads one or more local iCalendar (`.ics`) files and prints the
**free** meeting slots within your business hours, formatted for pasting into a
scheduling message.

## Why

You do not need any calendar API, OAuth, or network access. Export an `.ics`
from Google Calendar (Settings -> Import & export -> Export), Apple Calendar,
or Outlook, then point `freeslots` at the file. Everything runs offline on the
local `.ics` text.

The output is tuned for Japanese scheduling messages:

```
6/2(火) 13:00〜14:00、15:00〜17:00
6/3(水) 9:00〜18:00
```

## Install

```bash
npm install -g @printemps-tokyo/freeslots
# or run once without installing:
npx @printemps-tokyo/freeslots calendar.ics
```

Requires Node.js >= 20.

## Usage

```bash
freeslots [options] <calendar.ics...>
```

Pass multiple `.ics` files to merge all of their events.

```bash
# Next 7 days, default 09:00-19:00 business hours, weekdays only:
freeslots calendar.ics

# A specific window with a 60-minute minimum slot:
freeslots --from 2024-06-02 --to 2024-06-06 --duration 60 work.ics personal.ics

# Custom hours and days (include Saturday):
freeslots --hours 10:00-18:00 --days mon,tue,wed,thu,fri,sat calendar.ics

# JSON output:
freeslots --json calendar.ics
```

Example output:

```
6/2(火) 13:00〜14:00、15:00〜17:00
6/3(水) 9:00〜18:00
```

`--json` emits an array of days that have at least one slot:

```json
[
  {
    "date": "2024-06-02",
    "weekday": "火",
    "slots": [
      { "start": "13:00", "end": "14:00" },
      { "start": "15:00", "end": "17:00" }
    ]
  }
]
```

## Options

| Option | Description | Default |
| --- | --- | --- |
| `--from <YYYY-MM-DD>` | Inclusive start date (JST) | today in Asia/Tokyo |
| `--to <YYYY-MM-DD>` | Inclusive end date (JST) | `from` + 6 days (7-day window) |
| `--hours <HH:MM-HH:MM>` | Business hours | `09:00-19:00` |
| `--days <list>` | Business weekdays: `mon,tue,wed,thu,fri,sat,sun` | `mon,tue,wed,thu,fri` |
| `--duration <min>` | Minimum free-slot length in minutes | `30` |
| `--json` | Output JSON instead of the human format | off |
| `--ics-out <file>` | Also write the free slots to an `.ics` file | off |
| `--ics-summary <text>` | Event title used by `--ics-out` | `Free` |
| `-h, --help` | Show help | |
| `-v, --version` | Show version | |

Invalid arguments and unreadable files produce a clear error on stderr and a
non-zero exit code.

## Output format

One line per day that has at least one free slot (days with no free slot are
omitted):

```
M/D(W) H:MM〜H:MM、H:MM〜H:MM
```

- `M/D`: month/day with **no leading zeros** (e.g. `6/2`, `12/15`).
- `(W)`: Japanese weekday from `['日','月','火','水','木','金','土']`.
- time: 24-hour, hour without a leading zero, minute always 2 digits.
- range separator is the wave dash `〜` (U+301C), not an ASCII tilde.
- multiple slots on the same day are joined by the ideographic comma `、` (U+3001).

## Timezone and business rules

- **All output and day-bucketing are in Asia/Tokyo.** The Tokyo offset is
  derived via `Intl.DateTimeFormat` rather than hardcoded, so the tool is
  correct regardless of the host machine's timezone.
- Default business hours are **09:00-19:00** on **weekdays (Mon-Fri)**.
- **Free / transparent events do not block time.** An event with
  `TRANSP:TRANSPARENT` (or a timed event with no `DTEND`, i.e. zero duration)
  counts as *available*. Only `OPAQUE` (busy) events reduce availability.
- A free slot is business-hours time on a business day, minus the union of busy
  intervals, keeping only gaps at least `--duration` minutes long.

`.ics` date/time forms understood: UTC (`...Z`), floating local time (treated
as JST), `TZID=...` zoned times (Tokyo and other IANA zones), and all-day
`VALUE=DATE` events.

## Recurrence (RRULE) support

For correctness over completeness, `freeslots` expands a deliberately small,
well-tested subset of recurrence rules within the query window:

- `FREQ=DAILY` with optional `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`
  (`BYDAY` restricts to those weekdays, e.g. `FREQ=DAILY;BYDAY=MO,WE,FR`).
- `FREQ=WEEKLY` with optional `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`.
- `FREQ=MONTHLY` with optional `INTERVAL`, `COUNT`, `UNTIL`, `BYMONTHDAY`
  (`BYMONTHDAY=15` recurs on the 15th; without it, DTSTART's day-of-month is
  used). A day that does not exist in a month (e.g. the 31st of June) is skipped.
- `EXDATE` exclusions, matched by **JST calendar day** (so a date-only
  `EXDATE;VALUE=DATE:...` or a differently-timed `EXDATE` still excludes the
  matching day). This excludes the whole JST day, which is correct for the
  one-occurrence-per-day rules above.
- `UNTIL`: a `...Z` value is treated as UTC; a date-only or floating value is
  interpreted in **JST** (a date-only `UNTIL` runs through the end of that JST day).
- `DURATION`: a `VEVENT` with `DURATION` and no `DTEND` uses
  `start + DURATION` as its end (e.g. `DURATION:PT1H`); when both are present,
  `DTEND` wins.

All recurrence day-bucketing (weekly/daily anchoring and `BYDAY` matching) is
computed in **Asia/Tokyo**, so instances land on the correct JST day regardless
of the host timezone.

Anything else (`FREQ=YEARLY`, `BYSETPOS`, positional `BYDAY` like `2MO`,
negative `BYMONTHDAY`, a `WKST` other than the default on a weekly rule with
`INTERVAL>1`, etc.) is **skipped, not silently dropped**: the run prints a
note to stderr such as:

```
note: skipped 2 event(s) with unsupported recurrence rules
```

## Programmatic API

The pure logic is exported for use as a library:

```ts
import {
  parseIcs,
  collectBusyIntervals,
  computeFreeSlots,
  formatSlots,
  jstMidnightMs,
} from "@printemps-tokyo/freeslots";
import { readFileSync } from "node:fs";

const events = parseIcs(readFileSync("calendar.ics", "utf8"));

const windowStartMs = jstMidnightMs("2024-06-02");
const windowEndMs = jstMidnightMs("2024-06-06") + 24 * 60 * 60 * 1000;
const { busy } = collectBusyIntervals(events, windowStartMs, windowEndMs);

const days = computeFreeSlots(busy, {
  fromDate: "2024-06-02",
  toDate: "2024-06-06",
  openMin: 9 * 60,
  closeMin: 19 * 60,
  businessDays: new Set([1, 2, 3, 4, 5]),
  minDurationMin: 30,
});

console.log(formatSlots(days));
```

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

## License

[MIT](./LICENSE) (c) printemps.tokyo
