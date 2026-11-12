import { describe, expect, it } from "vitest";
import { allDayDates, parseIcs } from "../src/index.js";

const jst = (d: string): number => Date.parse(`${d}T00:00:00+09:00`);

const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  // A transparent all-day holiday, as public-holiday feeds publish them.
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261123",
  "DTEND;VALUE=DATE:20261124",
  "SUMMARY:Labor Thanksgiving Day",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
  // Three days.
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261230",
  "DTEND;VALUE=DATE:20270102",
  "SUMMARY:Year-end",
  "END:VEVENT",
  // A timed event is not a day off.
  "BEGIN:VEVENT",
  "DTSTART:20261125T010000Z",
  "DTEND:20261125T020000Z",
  "SUMMARY:Meeting",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("allDayDates", () => {
  it("takes every day all-day events cover, transparent or not", () => {
    const days = allDayDates(parseIcs(FEED), jst("2026-11-01"), jst("2027-01-31"));
    expect([...days].sort()).toEqual(["2026-11-23", "2026-12-30", "2026-12-31", "2027-01-01"]);
  });

  it("keeps to the window", () => {
    const days = allDayDates(parseIcs(FEED), jst("2026-12-31"), jst("2027-01-05"));
    expect([...days].sort()).toEqual(["2026-12-31", "2027-01-01"]);
  });
});
