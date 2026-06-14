import { describe, expect, it } from "vitest";
import {
  computeFreeSlots,
  mergeIntervals,
  subtractBusy,
  jstMidnightMs,
  jstWeekday,
  type BusinessRules,
  type BusyInterval,
} from "../src/freeslots.js";

/** A JST timestamp helper: build epoch ms from JST wall-clock fields. */
function jst(date: string, hour: number, minute = 0): number {
  // JST is UTC+9 with no DST; subtract 9h from the UTC reading of the fields.
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y as number, (m as number) - 1, d as number, hour - 9, minute, 0);
}

const baseRules = (over: Partial<BusinessRules> = {}): BusinessRules => ({
  fromDate: "2024-06-03", // Monday
  toDate: "2024-06-03",
  openMin: 9 * 60,
  closeMin: 19 * 60,
  businessDays: new Set([1, 2, 3, 4, 5]),
  minDurationMin: 30,
  ...over,
});

describe("mergeIntervals", () => {
  it("merges overlapping intervals", () => {
    expect(
      mergeIntervals([
        { startMin: 540, endMin: 600 },
        { startMin: 570, endMin: 660 },
      ]),
    ).toEqual([{ startMin: 540, endMin: 660 }]);
  });

  it("merges adjacent (touching) intervals", () => {
    expect(
      mergeIntervals([
        { startMin: 540, endMin: 600 },
        { startMin: 600, endMin: 660 },
      ]),
    ).toEqual([{ startMin: 540, endMin: 660 }]);
  });

  it("keeps disjoint intervals separate and sorted", () => {
    expect(
      mergeIntervals([
        { startMin: 700, endMin: 720 },
        { startMin: 540, endMin: 600 },
      ]),
    ).toEqual([
      { startMin: 540, endMin: 600 },
      { startMin: 700, endMin: 720 },
    ]);
  });
});

describe("subtractBusy", () => {
  it("returns the whole window when nothing is busy", () => {
    expect(subtractBusy(540, 1140, [], 30)).toEqual([{ startMin: 540, endMin: 1140 }]);
  });

  it("subtracts a midday meeting", () => {
    // 12:00-13:00 busy -> 9-12 and 13-19 free.
    expect(subtractBusy(540, 1140, [{ startMin: 720, endMin: 780 }], 30)).toEqual([
      { startMin: 540, endMin: 720 },
      { startMin: 780, endMin: 1140 },
    ]);
  });

  it("clamps busy intervals to the window", () => {
    // Busy 7:00-10:00 clamps to 9:00-10:00 -> free 10:00-19:00.
    expect(subtractBusy(540, 1140, [{ startMin: 420, endMin: 600 }], 30)).toEqual([
      { startMin: 600, endMin: 1140 },
    ]);
  });

  it("drops gaps shorter than the minimum duration", () => {
    // Two meetings leave a 20-minute gap (10:00-10:20) which is filtered out.
    const free = subtractBusy(
      540,
      1140,
      [
        { startMin: 540, endMin: 600 }, // 9-10
        { startMin: 620, endMin: 1140 }, // 10:20-19
      ],
      30,
    );
    expect(free).toEqual([]);
  });
});

describe("computeFreeSlots", () => {
  it("returns full business hours for a day with no busy events", () => {
    const days = computeFreeSlots([], baseRules());
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ date: "2024-06-03", weekday: 1 });
    expect(days[0]?.slots).toEqual([{ startMin: 540, endMin: 1140 }]);
  });

  it("subtracts overlapping busy events", () => {
    const busy: BusyInterval[] = [
      { startMs: jst("2024-06-03", 12), endMs: jst("2024-06-03", 13) },
      { startMs: jst("2024-06-03", 12, 30), endMs: jst("2024-06-03", 14) },
    ];
    const days = computeFreeSlots(busy, baseRules());
    expect(days[0]?.slots).toEqual([
      { startMin: 540, endMin: 720 }, // 9:00-12:00
      { startMin: 840, endMin: 1140 }, // 14:00-19:00
    ]);
  });

  it("handles an event spanning midnight (only the in-day part blocks)", () => {
    // Busy 18:00 (Mon) -> 02:00 (Tue). On Monday it blocks 18:00-19:00.
    const busy: BusyInterval[] = [
      { startMs: jst("2024-06-03", 18), endMs: jst("2024-06-04", 2) },
    ];
    const days = computeFreeSlots(busy, baseRules({ toDate: "2024-06-04" }));
    const mon = days.find((d) => d.date === "2024-06-03");
    expect(mon?.slots).toEqual([{ startMin: 540, endMin: 1080 }]); // 9:00-18:00
    const tue = days.find((d) => d.date === "2024-06-04");
    // Tuesday: 02:00 is before business open, so the whole day is free.
    expect(tue?.slots).toEqual([{ startMin: 540, endMin: 1140 }]);
  });

  it("blocks the whole day with an all-day event", () => {
    // All-day Monday: busy 00:00-24:00 JST.
    const busy: BusyInterval[] = [
      { startMs: jstMidnightMs("2024-06-03"), endMs: jstMidnightMs("2024-06-04") },
    ];
    const days = computeFreeSlots(busy, baseRules());
    expect(days).toHaveLength(0);
  });

  it("ignores a busy interval entirely outside business hours", () => {
    const busy: BusyInterval[] = [
      { startMs: jst("2024-06-03", 6), endMs: jst("2024-06-03", 8) },
    ];
    const days = computeFreeSlots(busy, baseRules());
    expect(days[0]?.slots).toEqual([{ startMin: 540, endMin: 1140 }]);
  });

  it("clips a busy interval partially outside business hours", () => {
    // 18:00-21:00 -> only 18:00-19:00 counts -> free 9:00-18:00.
    const busy: BusyInterval[] = [
      { startMs: jst("2024-06-03", 18), endMs: jst("2024-06-03", 21) },
    ];
    const days = computeFreeSlots(busy, baseRules());
    expect(days[0]?.slots).toEqual([{ startMin: 540, endMin: 1080 }]);
  });

  it("excludes weekends by default", () => {
    // 2024-06-08 is a Saturday, 06-09 a Sunday.
    const days = computeFreeSlots([], baseRules({ fromDate: "2024-06-08", toDate: "2024-06-09" }));
    expect(days).toHaveLength(0);
  });

  it("respects a custom --days set including Saturday", () => {
    const days = computeFreeSlots(
      [],
      baseRules({ fromDate: "2024-06-08", toDate: "2024-06-08", businessDays: new Set([6]) }),
    );
    expect(days).toHaveLength(1);
    expect(days[0]?.weekday).toBe(6);
  });

  it("applies a custom minimum duration", () => {
    // Leave a 45-min gap; duration 60 filters it out, duration 30 keeps it.
    const busy: BusyInterval[] = [
      { startMs: jst("2024-06-03", 9), endMs: jst("2024-06-03", 12) },
      { startMs: jst("2024-06-03", 12, 45), endMs: jst("2024-06-03", 19) },
    ];
    expect(computeFreeSlots(busy, baseRules({ minDurationMin: 30 }))[0]?.slots).toEqual([
      { startMin: 720, endMin: 765 },
    ]);
    expect(computeFreeSlots(busy, baseRules({ minDurationMin: 60 }))).toHaveLength(0);
  });

  it("throws when open >= close", () => {
    expect(() => computeFreeSlots([], baseRules({ openMin: 1140, closeMin: 540 }))).toThrow();
  });

  it("throws when from > to", () => {
    expect(() =>
      computeFreeSlots([], baseRules({ fromDate: "2024-06-05", toDate: "2024-06-03" })),
    ).toThrow();
  });
});

describe("jst helpers", () => {
  it("jstWeekday returns Monday=1 for 2024-06-03", () => {
    expect(jstWeekday(jstMidnightMs("2024-06-03"))).toBe(1);
  });

  it("jstMidnightMs maps to the correct UTC instant (+9)", () => {
    expect(jstMidnightMs("2024-06-03")).toBe(Date.UTC(2024, 5, 2, 15, 0, 0));
  });
});
