import { describe, expect, it } from "vitest";
import { buildIcs, jstWallToUtcStamp, utcStamp } from "../src/ics-export.js";
import type { DayFreeSlots } from "../src/freeslots.js";

describe("jstWallToUtcStamp", () => {
  it("converts JST wall time to a UTC iCalendar stamp", () => {
    // 09:00 JST = 00:00 UTC on the same date.
    expect(jstWallToUtcStamp("2026-06-15", 9 * 60)).toBe("20260615T000000Z");
    // 00:00 JST = 15:00 UTC on the previous date.
    expect(jstWallToUtcStamp("2026-06-15", 0)).toBe("20260614T150000Z");
    // 19:00 JST = 10:00 UTC.
    expect(jstWallToUtcStamp("2026-06-15", 19 * 60)).toBe("20260615T100000Z");
  });
});

describe("utcStamp", () => {
  it("formats an instant as YYYYMMDDTHHMMSSZ", () => {
    expect(utcStamp(Date.UTC(2026, 5, 15, 1, 2, 3))).toBe("20260615T010203Z");
  });
});

describe("buildIcs", () => {
  it("emits one VEVENT per free slot with UTC times", () => {
    const days: DayFreeSlots[] = [
      { date: "2026-06-15", weekday: 1, slots: [{ startMin: 9 * 60, endMin: 12 * 60 }] },
      { date: "2026-06-16", weekday: 2, slots: [{ startMin: 13 * 60, endMin: 14 * 60 }] },
    ];
    const ics = buildIcs(days, { dtstamp: "20260101T000000Z", summary: "Open" });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect(ics).toContain("DTSTART:20260615T000000Z");
    expect(ics).toContain("DTEND:20260615T030000Z");
    expect(ics).toContain("SUMMARY:Open");
    // CRLF line endings.
    expect(ics).toContain("\r\n");
  });

  it("defaults the summary to Free", () => {
    const days: DayFreeSlots[] = [
      { date: "2026-06-15", weekday: 1, slots: [{ startMin: 540, endMin: 600 }] },
    ];
    expect(buildIcs(days, { dtstamp: "20260101T000000Z" })).toContain("SUMMARY:Free");
  });
});
