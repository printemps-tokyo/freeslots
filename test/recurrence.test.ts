import { describe, expect, it } from "vitest";
import { parseIcs, toJstWall, parseIcsDuration } from "../src/ics.js";
import { expandEvent, parseRrule } from "../src/recurrence.js";

/** Build a minimal VCALENDAR wrapping the given VEVENT body lines. */
function ics(...vevents: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    ...vevents,
    "END:VCALENDAR",
  ].join("\r\n");
}

function vevent(...lines: string[]): string {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

/** JST date-key (YYYY-MM-DD) of an instant, for asserting which JST day it lands on. */
function jstKey(ms: number): string {
  const w = toJstWall(ms);
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${w.year}-${p(w.month)}-${p(w.day)}`;
}

// A generous window covering June 2024 in JST.
const windowStart = Date.UTC(2024, 4, 25, 0, 0, 0);
const windowEnd = Date.UTC(2024, 6, 5, 0, 0, 0);

describe("FIX 1: WEEKLY BYDAY anchors on the JST weekday", () => {
  it("expands BYDAY=MO onto JST Mondays for a JST-zoned DTSTART that is Sunday in UTC", () => {
    // 2024-06-03 08:00 JST = Mon 08:00 JST, which is 2024-06-02 23:00 UTC (Sunday).
    // A UTC-anchored expansion would wrongly land on Tuesdays.
    const events = parseIcs(
      ics(
        vevent(
          "DTSTART;TZID=Asia/Tokyo:20240603T080000",
          "DTEND;TZID=Asia/Tokyo:20240603T090000",
          "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3",
        ),
      ),
    );
    const out = expandEvent(events[0]!, windowStart, windowEnd);
    expect(out.unsupported).toBe(false);
    expect(out.instances).toHaveLength(3);
    const keys = out.instances.map((i) => jstKey(i.startMs));
    expect(keys).toEqual(["2024-06-03", "2024-06-10", "2024-06-17"]);
    // Each instance keeps the original JST time-of-day (08:00 JST).
    for (const inst of out.instances) {
      const w = toJstWall(inst.startMs);
      expect(w.hour).toBe(8);
      expect(w.minute).toBe(0);
    }
  });
});

describe("FIX 2: DAILY + BYDAY emits only the listed JST weekdays", () => {
  it("FREQ=DAILY;BYDAY=MO,WE,FR over one week yields only Mon/Wed/Fri (JST)", () => {
    // 2024-06-03 is a Monday (JST). One-week window: 6/3 .. 6/9.
    const events = parseIcs(
      ics(
        vevent(
          "DTSTART;TZID=Asia/Tokyo:20240603T100000",
          "DTEND;TZID=Asia/Tokyo:20240603T110000",
          "RRULE:FREQ=DAILY;BYDAY=MO,WE,FR",
        ),
      ),
    );
    const wStart = Date.UTC(2024, 5, 2, 15, 0, 0); // 2024-06-03 00:00 JST
    const wEnd = Date.UTC(2024, 5, 9, 15, 0, 0); // 2024-06-10 00:00 JST
    const out = expandEvent(events[0]!, wStart, wEnd);
    expect(out.unsupported).toBe(false);
    const keys = out.instances.map((i) => jstKey(i.startMs));
    expect(keys).toEqual(["2024-06-03", "2024-06-05", "2024-06-07"]);
  });
});

describe("FIX 3: EXDATE excludes by JST calendar day", () => {
  it("date-only EXDATE excludes the matching JST-day instance", () => {
    // DTSTART 2024-06-02 04:00Z = 2024-06-02 13:00 JST. DAILY;COUNT=3 -> 6/2,6/3,6/4 (JST).
    const events = parseIcs(
      ics(
        vevent(
          "DTSTART:20240602T040000Z",
          "DTEND:20240602T050000Z",
          "RRULE:FREQ=DAILY;COUNT=3",
          "EXDATE;VALUE=DATE:20240603",
        ),
      ),
    );
    const out = expandEvent(events[0]!, windowStart, windowEnd);
    const keys = out.instances.map((i) => jstKey(i.startMs));
    expect(keys).toEqual(["2024-06-02", "2024-06-04"]);
  });

  it("a timed EXDATE matching an instance's JST day also excludes it", () => {
    // EXDATE is a timed value on the same JST day but a different time than the
    // instance; the JST-day match still excludes it.
    const events = parseIcs(
      ics(
        vevent(
          "DTSTART:20240602T040000Z",
          "DTEND:20240602T050000Z",
          "RRULE:FREQ=DAILY;COUNT=3",
          "EXDATE:20240603T000000Z", // 2024-06-03 09:00 JST -> same JST day as the 6/3 instance
        ),
      ),
    );
    const out = expandEvent(events[0]!, windowStart, windowEnd);
    const keys = out.instances.map((i) => jstKey(i.startMs));
    expect(keys).toEqual(["2024-06-02", "2024-06-04"]);
  });
});

describe("FIX 4: date-only UNTIL is the end of the JST day, not the UTC day", () => {
  it("includes the occurrence on the UNTIL JST date and excludes the next JST day", () => {
    // DTSTART 2024-06-03 02:00 JST (= 2024-06-02 17:00 UTC). The next instance,
    // 2024-06-04 02:00 JST, is 2024-06-03 17:00 UTC -- still inside the UTC day
    // 2024-06-03, so a UTC end-of-day UNTIL would wrongly include it. A JST
    // end-of-day UNTIL=20240603 must exclude the 6/4 (JST) instance.
    const events = parseIcs(
      ics(
        vevent(
          "DTSTART;TZID=Asia/Tokyo:20240603T020000",
          "DTEND;TZID=Asia/Tokyo:20240603T030000",
          "RRULE:FREQ=DAILY;UNTIL=20240603",
        ),
      ),
    );
    const out = expandEvent(events[0]!, windowStart, windowEnd);
    const keys = out.instances.map((i) => jstKey(i.startMs));
    expect(keys).toEqual(["2024-06-03"]);
  });
});

describe("FIX 7: far-past unbounded recurrence still reaches the window", () => {
  it("FREQ=DAILY with no COUNT/UNTIL starting decades earlier produces in-window instances", () => {
    // DTSTART in 1990 is > 10000 days (the MAX_ITERATIONS cap) before the 2024
    // window, so iterating from occurrence 0 would exhaust the cap and never
    // reach the window. Fast-forwarding the start index fixes this.
    const events = parseIcs(
      ics(
        vevent(
          "DTSTART;TZID=Asia/Tokyo:19900101T100000",
          "DTEND;TZID=Asia/Tokyo:19900101T110000",
          "RRULE:FREQ=DAILY",
        ),
      ),
    );
    const wStart = Date.UTC(2024, 5, 2, 15, 0, 0); // 2024-06-03 00:00 JST
    const wEnd = Date.UTC(2024, 5, 9, 15, 0, 0); // 2024-06-10 00:00 JST (7-day window)
    const out = expandEvent(events[0]!, wStart, wEnd);
    expect(out.unsupported).toBe(false);
    const keys = out.instances.map((i) => jstKey(i.startMs));
    expect(keys).toEqual([
      "2024-06-03",
      "2024-06-04",
      "2024-06-05",
      "2024-06-06",
      "2024-06-07",
      "2024-06-08",
      "2024-06-09",
    ]);
  });

  it("far-past WEEKLY;BYDAY unbounded still reaches the window within the iteration cap", () => {
    // 1800-01-06 was a Monday. It is ~11700 weeks (> MAX_ITERATIONS=10000)
    // before the 2024 window, so iterating from week 0 would exhaust the cap
    // before reaching the window. Fast-forwarding the start week fixes it.
    const events = parseIcs(
      ics(
        vevent(
          "DTSTART;TZID=Asia/Tokyo:18000106T090000",
          "DTEND;TZID=Asia/Tokyo:18000106T100000",
          "RRULE:FREQ=WEEKLY;BYDAY=MO",
        ),
      ),
    );
    const wStart = Date.UTC(2024, 5, 2, 15, 0, 0); // 2024-06-03 00:00 JST
    const wEnd = Date.UTC(2024, 5, 16, 15, 0, 0); // 2024-06-17 00:00 JST
    const out = expandEvent(events[0]!, wStart, wEnd);
    const keys = out.instances.map((i) => jstKey(i.startMs));
    expect(keys).toEqual(["2024-06-03", "2024-06-10"]);
  });
});

describe("FIX 8: WKST with WEEKLY INTERVAL>1 is unsupported", () => {
  it("returns null (unsupported) for WKST + WEEKLY + INTERVAL>1", () => {
    expect(parseRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=SU")).toBeNull();
  });

  it("allows WKST when INTERVAL==1 (WKST has no effect)", () => {
    expect(parseRrule("FREQ=WEEKLY;BYDAY=MO;WKST=SU")).not.toBeNull();
  });

  it("expandEvent reports the WKST+INTERVAL>1 rule as unsupported", () => {
    const events = parseIcs(
      ics(
        vevent(
          "DTSTART;TZID=Asia/Tokyo:20240603T100000",
          "DTEND;TZID=Asia/Tokyo:20240603T110000",
          "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=SU",
        ),
      ),
    );
    const out = expandEvent(events[0]!, windowStart, windowEnd);
    expect(out.unsupported).toBe(true);
    expect(out.instances).toHaveLength(0);
  });
});

describe("FIX 5: parseIcsDuration", () => {
  it("parses common DURATION forms to milliseconds", () => {
    expect(parseIcsDuration("PT1H")).toBe(60 * 60 * 1000);
    expect(parseIcsDuration("PT1H30M")).toBe(90 * 60 * 1000);
    expect(parseIcsDuration("PT45M")).toBe(45 * 60 * 1000);
    expect(parseIcsDuration("PT90M")).toBe(90 * 60 * 1000);
    expect(parseIcsDuration("P1D")).toBe(24 * 60 * 60 * 1000);
    expect(parseIcsDuration("P1DT2H")).toBe((24 + 2) * 60 * 60 * 1000);
    expect(parseIcsDuration("P1W")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseIcsDuration("PT0S")).toBe(0);
  });

  it("treats negative or unparseable durations as zero-length", () => {
    expect(parseIcsDuration("-PT1H")).toBe(0);
    expect(parseIcsDuration("P")).toBe(0);
    expect(parseIcsDuration("garbage")).toBe(0);
  });
});

describe("FIX 5: VEVENT with DURATION and no DTEND", () => {
  it("uses startMs + DURATION as the end when DTEND is absent", () => {
    const events = parseIcs(
      ics(vevent("DTSTART:20240602T040000Z", "DURATION:PT1H")),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.startMs).toBe(Date.UTC(2024, 5, 2, 4, 0, 0));
    expect(events[0]?.endMs).toBe(Date.UTC(2024, 5, 2, 5, 0, 0));
  });

  it("lets DTEND win when both DTEND and DURATION are present", () => {
    const events = parseIcs(
      ics(
        vevent(
          "DTSTART:20240602T040000Z",
          "DTEND:20240602T060000Z",
          "DURATION:PT1H",
        ),
      ),
    );
    expect(events[0]?.endMs).toBe(Date.UTC(2024, 5, 2, 6, 0, 0));
  });
});

describe("MONTHLY recurrence", () => {
  function expandOne(...lines: string[]) {
    const events = parseIcs(ics(vevent(...lines)));
    return expandEvent(events[0]!, windowStart, windowEnd).instances;
  }

  it("expands BYMONTHDAY onto that day each month (JST)", () => {
    const inst = expandOne(
      "DTSTART;TZID=Asia/Tokyo:20240115T100000",
      "DTEND;TZID=Asia/Tokyo:20240115T110000",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=15",
    );
    // Only the June 15 occurrence falls in the window.
    expect(inst.map((e) => jstKey(e.startMs))).toEqual(["2024-06-15"]);
  });

  it("uses DTSTART's day-of-month when BYMONTHDAY is absent", () => {
    const inst = expandOne(
      "DTSTART;TZID=Asia/Tokyo:20240510T093000",
      "DTEND;TZID=Asia/Tokyo:20240510T100000",
      "RRULE:FREQ=MONTHLY",
    );
    expect(inst.map((e) => jstKey(e.startMs))).toEqual(["2024-06-10"]);
  });

  it("skips months without the requested day (Feb/Apr/Jun have no 31st)", () => {
    const inst = expandOne(
      "DTSTART;TZID=Asia/Tokyo:20240131T100000",
      "DTEND;TZID=Asia/Tokyo:20240131T110000",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=31",
    );
    // The window (May 25 - Jul 5) contains May 31 but not a June 31 (skipped).
    expect(inst.map((e) => jstKey(e.startMs))).toEqual(["2024-05-31"]);
  });

  it("supports INTERVAL between months", () => {
    // Every 2 months from Feb 20 -> Apr, Jun, ... June 20 is in the window.
    const inst = expandOne(
      "DTSTART;TZID=Asia/Tokyo:20240220T100000",
      "DTEND;TZID=Asia/Tokyo:20240220T110000",
      "RRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=20",
    );
    expect(inst.map((e) => jstKey(e.startMs))).toEqual(["2024-06-20"]);
  });

  it("parses MONTHLY+BYMONTHDAY but rejects positional MONTHLY+BYDAY", () => {
    expect(parseRrule("FREQ=MONTHLY;BYMONTHDAY=1,15")).not.toBeNull();
    expect(parseRrule("FREQ=MONTHLY;BYDAY=2MO")).toBeNull();
    // BYMONTHDAY with a non-MONTHLY freq stays unsupported.
    expect(parseRrule("FREQ=WEEKLY;BYMONTHDAY=15")).toBeNull();
  });
});
