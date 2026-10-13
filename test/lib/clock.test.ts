import { describe, it, expect } from "vitest";
import {
  FakeClock, toUtcIso, sgtDateKey, sgtTimeHHMM, sgtAt, addDaysToKey,
  startOfSgtDay, formatSgt, isQuietTime, HOUR_MS,
} from "../../src/lib/clock.js";

describe("clock", () => {
  it("FakeClock set/advance", () => {
    const c = new FakeClock("2026-10-14T00:00:00Z");
    c.advance(HOUR_MS);
    expect(c.now().toISOString()).toBe("2026-10-14T01:00:00.000Z");
    c.set("2026-10-15T00:00:00+08:00");
    expect(c.now().toISOString()).toBe("2026-10-14T16:00:00.000Z");
  });

  it("toUtcIso normalises +08:00", () => {
    expect(toUtcIso("2026-10-14T15:00:00+08:00")).toBe("2026-10-14T07:00:00.000Z");
    expect(() => toUtcIso("not a date")).toThrow(/Invalid date/);
  });

  it("sgtDateKey rolls over at 16:00Z", () => {
    expect(sgtDateKey(new Date("2026-10-14T15:59:00Z"))).toBe("2026-10-14");
    expect(sgtDateKey(new Date("2026-10-14T16:00:00Z"))).toBe("2026-10-15");
  });

  it("sgtTimeHHMM / sgtAt / startOfSgtDay / addDaysToKey", () => {
    expect(sgtTimeHHMM(new Date("2026-10-13T22:30:00Z"))).toBe("06:30");
    expect(sgtAt("2026-10-14", "06:30").toISOString()).toBe("2026-10-13T22:30:00.000Z");
    expect(startOfSgtDay(new Date("2026-10-14T10:00:00Z")).toISOString()).toBe("2026-10-13T16:00:00.000Z");
    expect(addDaysToKey("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysToKey("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("formatSgt", () => {
    const d = new Date("2026-10-14T07:00:00Z"); // Wed 14 Oct, 15:00 SGT
    expect(formatSgt(d, "time")).toBe("3pm");
    expect(formatSgt(new Date("2026-10-14T07:30:00Z"), "time")).toBe("3:30pm");
    expect(formatSgt(new Date("2026-10-13T16:00:00Z"), "time")).toBe("12am");
    expect(formatSgt(new Date("2026-10-14T04:00:00Z"), "time")).toBe("12pm");
    expect(formatSgt(d, "dayDate")).toBe("Wed 14 Oct");
    expect(formatSgt(d, "dayDateTime")).toBe("Wed 14 Oct, 3pm");
  });

  it("quiet hours wrap midnight", () => {
    const at = (hhmm: string) => sgtAt("2026-10-14", hhmm);
    expect(isQuietTime(at("23:00"), "22:30", "06:30")).toBe(true);
    expect(isQuietTime(at("05:00"), "22:30", "06:30")).toBe(true);
    expect(isQuietTime(at("06:30"), "22:30", "06:30")).toBe(false);
    expect(isQuietTime(at("12:00"), "22:30", "06:30")).toBe(false);
    expect(isQuietTime(at("13:00"), "12:00", "14:00")).toBe(true); // non-wrapping window
  });
});
