import { describe, expect, it } from "vitest";
import {
  formatSlots,
  formatDayLine,
  formatTime,
  toJson,
  WEEKDAY_CHARS,
} from "../src/format.js";
import type { DayFreeSlots } from "../src/freeslots.js";

describe("formatTime", () => {
  it("formats with no leading zero on the hour and 2-digit minutes", () => {
    expect(formatTime(9 * 60)).toBe("9:00");
    expect(formatTime(13 * 60 + 5)).toBe("13:05");
    expect(formatTime(18 * 60 + 30)).toBe("18:30");
  });
});

describe("WEEKDAY_CHARS", () => {
  it("indexes by JS getDay() (0=Sun .. 6=Sat)", () => {
    expect(WEEKDAY_CHARS).toEqual(["日", "月", "火", "水", "木", "金", "土"]);
  });
});

describe("formatDayLine", () => {
  it("matches the exact worked example with multiple slots", () => {
    const day: DayFreeSlots = {
      date: "2024-06-02",
      weekday: 2, // 火 (Tue)
      slots: [
        { startMin: 13 * 60, endMin: 14 * 60 },
        { startMin: 15 * 60, endMin: 17 * 60 },
      ],
    };
    // 6/2(火) 13:00〜14:00、15:00〜17:00
    expect(formatDayLine(day)).toBe("6/2(火) 13:00〜14:00、15:00〜17:00");
  });

  it("uses the WAVE DASH U+301C, not an ASCII tilde", () => {
    const day: DayFreeSlots = {
      date: "2024-06-03",
      weekday: 3,
      slots: [{ startMin: 9 * 60, endMin: 18 * 60 }],
    };
    const line = formatDayLine(day);
    expect(line).toContain("〜");
    expect(line).not.toContain("~");
    // 6/3(水) 9:00〜18:00 (no leading zeros on month/day)
    expect(line).toBe("6/3(水) 9:00〜18:00");
  });

  it("uses the IDEOGRAPHIC COMMA U+3001 between same-day slots", () => {
    const day: DayFreeSlots = {
      date: "2024-12-15",
      weekday: 1,
      slots: [
        { startMin: 9 * 60, endMin: 10 * 60 },
        { startMin: 11 * 60, endMin: 12 * 60 },
      ],
    };
    const line = formatDayLine(day);
    expect(line).toContain("、");
    // no leading zeros: 12/15
    expect(line.startsWith("12/15(月) ")).toBe(true);
  });

  it("puts a single ASCII space between (W) and the first range", () => {
    const day: DayFreeSlots = {
      date: "2024-06-02",
      weekday: 2,
      slots: [{ startMin: 13 * 60, endMin: 14 * 60 }],
    };
    expect(formatDayLine(day)).toBe("6/2(火) 13:00〜14:00");
  });
});

describe("formatSlots", () => {
  it("renders one line per day and omits days with no slots", () => {
    // computeFreeSlots already omits empty days, so the input only has days
    // that have slots; formatSlots simply joins them.
    const days: DayFreeSlots[] = [
      { date: "2024-06-02", weekday: 2, slots: [{ startMin: 780, endMin: 840 }, { startMin: 900, endMin: 1020 }] },
      { date: "2024-06-03", weekday: 3, slots: [{ startMin: 540, endMin: 1080 }] },
    ];
    expect(formatSlots(days)).toBe(
      "6/2(火) 13:00〜14:00、15:00〜17:00\n6/3(水) 9:00〜18:00",
    );
  });

  it("returns an empty string when there are no days", () => {
    expect(formatSlots([])).toBe("");
  });
});

describe("toJson", () => {
  it("produces the documented JSON shape", () => {
    const days: DayFreeSlots[] = [
      {
        date: "2024-06-02",
        weekday: 2,
        slots: [
          { startMin: 780, endMin: 840 },
          { startMin: 900, endMin: 1020 },
        ],
      },
    ];
    expect(toJson(days)).toEqual([
      {
        date: "2024-06-02",
        weekday: "火",
        slots: [
          { start: "13:00", end: "14:00" },
          { start: "15:00", end: "17:00" },
        ],
      },
    ]);
  });
});
