import { describe, expect, it } from "vitest";
import { parseIcs, unfoldLines, toJstWall } from "../src/ics.js";
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

describe("unfoldLines", () => {
  it("joins continuation lines that start with a space (leading space removed)", () => {
    // RFC 5545: the leading space is stripped and the lines are concatenated
    // with nothing inserted, so "Hello" + "World" -> "HelloWorld".
    const text = "SUMMARY:Hello\r\n World\r\nDTSTART:20240101T000000Z";
    expect(unfoldLines(text)).toEqual(["SUMMARY:HelloWorld", "DTSTART:20240101T000000Z"]);
  });

  it("joins continuation lines that start with a tab and handles LF endings", () => {
    const text = "SUMMARY:Foo\n\tBar";
    expect(unfoldLines(text)).toEqual(["SUMMARY:FooBar"]);
  });
});

describe("toJstWall", () => {
  it("maps a UTC instant to Asia/Tokyo wall-clock (+9, no hardcoding)", () => {
    // 2024-06-02T04:00:00Z == 2024-06-02 13:00 JST
    const ms = Date.UTC(2024, 5, 2, 4, 0, 0);
    expect(toJstWall(ms)).toEqual({ year: 2024, month: 6, day: 2, hour: 13, minute: 0 });
  });

  it("normalises midnight to hour 0", () => {
    const ms = Date.UTC(2024, 5, 1, 15, 0, 0); // 2024-06-02 00:00 JST
    expect(toJstWall(ms)).toEqual({ year: 2024, month: 6, day: 2, hour: 0, minute: 0 });
  });
});

describe("parseIcs - date/time forms", () => {
  it("parses a UTC timed event", () => {
    const events = parseIcs(
      ics(vevent("DTSTART:20240602T040000Z", "DTEND:20240602T050000Z")),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.startMs).toBe(Date.UTC(2024, 5, 2, 4, 0, 0));
    expect(events[0]?.endMs).toBe(Date.UTC(2024, 5, 2, 5, 0, 0));
    expect(events[0]?.allDay).toBe(false);
  });

  it("parses a floating time as JST wall-clock", () => {
    const events = parseIcs(
      ics(vevent("DTSTART:20240602T130000", "DTEND:20240602T140000")),
    );
    // 13:00 JST == 04:00 UTC
    expect(events[0]?.startMs).toBe(Date.UTC(2024, 5, 2, 4, 0, 0));
  });

  it("parses TZID=Asia/Tokyo identically to floating JST", () => {
    const events = parseIcs(
      ics(vevent("DTSTART;TZID=Asia/Tokyo:20240602T130000", "DTEND;TZID=Asia/Tokyo:20240602T140000")),
    );
    expect(events[0]?.startMs).toBe(Date.UTC(2024, 5, 2, 4, 0, 0));
  });

  it("parses a non-Tokyo TZID into the correct absolute instant", () => {
    // America/New_York is UTC-4 in June (EDT). 09:00 EDT == 13:00 UTC.
    const events = parseIcs(
      ics(vevent("DTSTART;TZID=America/New_York:20240602T090000", "DTEND;TZID=America/New_York:20240602T100000")),
    );
    expect(events[0]?.startMs).toBe(Date.UTC(2024, 5, 2, 13, 0, 0));
  });

  it("parses an all-day event anchored to JST midnight", () => {
    const events = parseIcs(ics(vevent("DTSTART;VALUE=DATE:20240602")));
    expect(events[0]?.allDay).toBe(true);
    // JST midnight of 2024-06-02 == 2024-06-01T15:00:00Z
    expect(events[0]?.startMs).toBe(Date.UTC(2024, 5, 1, 15, 0, 0));
    // No DTEND -> spans one full day.
    expect(events[0]?.endMs).toBe(Date.UTC(2024, 5, 2, 15, 0, 0));
  });

  it("treats a bare YYYYMMDD value as a date-only event", () => {
    const events = parseIcs(ics(vevent("DTSTART:20240602")));
    expect(events[0]?.allDay).toBe(true);
  });
});

describe("parseIcs - TRANSP and missing DTEND", () => {
  it("marks TRANSPARENT events as transparent", () => {
    const events = parseIcs(
      ics(vevent("DTSTART:20240602T040000Z", "DTEND:20240602T050000Z", "TRANSP:TRANSPARENT")),
    );
    expect(events[0]?.transparent).toBe(true);
  });

  it("defaults OPAQUE/absent TRANSP to not transparent", () => {
    const events = parseIcs(ics(vevent("DTSTART:20240602T040000Z", "DTEND:20240602T050000Z")));
    expect(events[0]?.transparent).toBe(false);
  });

  it("gives a timed event with no DTEND a zero-length interval", () => {
    const events = parseIcs(ics(vevent("DTSTART:20240602T040000Z")));
    expect(events[0]?.startMs).toBe(events[0]?.endMs);
  });
});

describe("parseRrule", () => {
  it("parses DAILY with INTERVAL/COUNT", () => {
    expect(parseRrule("FREQ=DAILY;INTERVAL=2;COUNT=3")).toMatchObject({
      freq: "DAILY",
      interval: 2,
      count: 3,
    });
  });

  it("parses WEEKLY with BYDAY", () => {
    const rule = parseRrule("FREQ=WEEKLY;BYDAY=MO,WE,FR");
    expect(rule?.freq).toBe("WEEKLY");
    expect(rule?.byDay).toEqual([1, 3, 5]);
  });

  it("returns null for unsupported FREQ", () => {
    expect(parseRrule("FREQ=MONTHLY")).toBeNull();
  });

  it("returns null for unsupported rule parts like BYMONTHDAY", () => {
    expect(parseRrule("FREQ=DAILY;BYMONTHDAY=1")).toBeNull();
  });

  it("returns null for positional BYDAY", () => {
    expect(parseRrule("FREQ=WEEKLY;BYDAY=2MO")).toBeNull();
  });
});

describe("expandEvent", () => {
  const windowStart = Date.UTC(2024, 5, 1, 0, 0, 0);
  const windowEnd = Date.UTC(2024, 5, 30, 0, 0, 0);

  it("passes non-recurring events through unchanged", () => {
    const events = parseIcs(ics(vevent("DTSTART:20240602T040000Z", "DTEND:20240602T050000Z")));
    const out = expandEvent(events[0]!, windowStart, windowEnd);
    expect(out.unsupported).toBe(false);
    expect(out.instances).toHaveLength(1);
  });

  it("expands FREQ=DAILY;COUNT within the window", () => {
    const events = parseIcs(
      ics(vevent("DTSTART:20240602T040000Z", "DTEND:20240602T050000Z", "RRULE:FREQ=DAILY;COUNT=3")),
    );
    const out = expandEvent(events[0]!, windowStart, windowEnd);
    expect(out.instances).toHaveLength(3);
    expect(out.instances[1]?.startMs).toBe(Date.UTC(2024, 5, 3, 4, 0, 0));
  });

  it("expands FREQ=WEEKLY;BYDAY=MO,WE", () => {
    // 2024-06-03 is a Monday.
    const events = parseIcs(
      ics(vevent("DTSTART:20240603T040000Z", "DTEND:20240603T050000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4")),
    );
    const out = expandEvent(events[0]!, windowStart, windowEnd);
    expect(out.instances).toHaveLength(4);
    // Mon 6/3, Wed 6/5, Mon 6/10, Wed 6/12
    const days = out.instances.map((i) => new Date(i.startMs).getUTCDate());
    expect(days).toEqual([3, 5, 10, 12]);
  });

  it("honours EXDATE", () => {
    const events = parseIcs(
      ics(
        vevent(
          "DTSTART:20240602T040000Z",
          "DTEND:20240602T050000Z",
          "RRULE:FREQ=DAILY;COUNT=3",
          "EXDATE:20240603T040000Z",
        ),
      ),
    );
    const out = expandEvent(events[0]!, windowStart, windowEnd);
    expect(out.instances).toHaveLength(2);
    const days = out.instances.map((i) => new Date(i.startMs).getUTCDate());
    expect(days).toEqual([2, 4]);
  });

  it("flags unsupported recurrence", () => {
    const events = parseIcs(
      ics(vevent("DTSTART:20240602T040000Z", "DTEND:20240602T050000Z", "RRULE:FREQ=MONTHLY")),
    );
    const out = expandEvent(events[0]!, windowStart, windowEnd);
    expect(out.unsupported).toBe(true);
    expect(out.instances).toHaveLength(0);
  });
});
