import { describe, expect, it } from "vitest";
import {
  computeOverlapSlots,
  formatOverlapDayLine,
} from "../src/overlap.js";
import type { BusinessRules, BusyInterval } from "../src/freeslots.js";

/** Absolute ms for a JST wall time on the given date (JST = UTC+9). */
function jst(date: string, hour: number, min = 0): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y as number, (m as number) - 1, d as number, hour, min) - 9 * 3600_000;
}

const rules: BusinessRules = {
  fromDate: "2024-06-03", // Monday
  toDate: "2024-06-03",
  openMin: 9 * 60,
  closeMin: 19 * 60,
  businessDays: new Set([1, 2, 3, 4, 5]),
  minDurationMin: 30,
};

// Person A busy 10-12, Person B busy 13-14.
const A: BusyInterval[] = [{ startMs: jst("2024-06-03", 10), endMs: jst("2024-06-03", 12) }];
const B: BusyInterval[] = [{ startMs: jst("2024-06-03", 13), endMs: jst("2024-06-03", 14) }];

describe("computeOverlapSlots", () => {
  it("require=all yields only the everyone-free windows", () => {
    const days = computeOverlapSlots([A, B], ["A", "B"], rules, 2);
    expect(days).toHaveLength(1);
    expect(days[0]?.slots).toEqual([
      { startMin: 540, endMin: 600, busy: [] }, // 9:00-10:00
      { startMin: 720, endMin: 780, busy: [] }, // 12:00-13:00
      { startMin: 840, endMin: 1140, busy: [] }, // 14:00-19:00
    ]);
  });

  it("require<all keeps partial windows and annotates who is busy", () => {
    const days = computeOverlapSlots([A, B], ["A", "B"], rules, 1);
    expect(days[0]?.slots).toEqual([
      { startMin: 540, endMin: 600, busy: [] },
      { startMin: 600, endMin: 720, busy: ["A"] }, // 10:00-12:00 A busy
      { startMin: 720, endMin: 780, busy: [] },
      { startMin: 780, endMin: 840, busy: ["B"] }, // 13:00-14:00 B busy
      { startMin: 840, endMin: 1140, busy: [] },
    ]);
  });

  it("formats busy annotation as (X不可)", () => {
    const line = formatOverlapDayLine({
      date: "2024-06-03",
      weekday: 1,
      slots: [
        { startMin: 540, endMin: 600, busy: [] },
        { startMin: 600, endMin: 720, busy: ["A"] },
      ],
    });
    expect(line).toBe("6/3(月) 9:00〜10:00、10:00〜12:00(A不可)");
  });
});
