import { describe, it, expect } from "vitest";
import { classroomDueAt } from "../../src/classroom/due.js";
import { sgtDateKey } from "../../src/lib/clock.js";

describe("classroomDueAt", () => {
  it("combines UTC dueDate + dueTime into one UTC instant", () => {
    // The teacher picked 23:59 SGT on Thu 15 Oct, so the API sends 15 Oct 15:59 UTC.
    expect(classroomDueAt({ year: 2026, month: 10, day: 15 }, { hours: 15, minutes: 59 })).toBe("2026-10-15T15:59:00.000Z");
  });

  it("crosses the SGT date line: a UTC date of the 15th can be the 16th in Singapore", () => {
    const due = classroomDueAt({ year: 2026, month: 10, day: 15 }, { hours: 23 })!;
    expect(due).toBe("2026-10-15T23:00:00.000Z");
    expect(sgtDateKey(new Date(due))).toBe("2026-10-16");
  });

  it("treats an empty TimeOfDay (zero fields omitted) as 00:00 UTC", () => {
    expect(classroomDueAt({ year: 2026, month: 10, day: 16 }, {})).toBe("2026-10-16T00:00:00.000Z");
  });

  it("falls back to 23:59 SGT on dueDate when dueTime is absent", () => {
    expect(classroomDueAt({ year: 2026, month: 10, day: 15 }, null)).toBe("2026-10-15T15:59:00.000Z");
    expect(classroomDueAt({ year: 2026, month: 10, day: 15 })).toBe("2026-10-15T15:59:00.000Z");
  });

  it("returns null without a complete, real date", () => {
    expect(classroomDueAt(null, { hours: 3 })).toBeNull();
    expect(classroomDueAt(undefined, undefined)).toBeNull();
    expect(classroomDueAt({ year: 2026, month: 10 }, { hours: 3 })).toBeNull();
    expect(classroomDueAt({ year: 2026, month: 2, day: 30 }, { hours: 3 })).toBeNull();
  });

  it("keeps seconds and ignores nanos", () => {
    expect(classroomDueAt({ year: 2026, month: 10, day: 15 }, { hours: 1, minutes: 2, seconds: 3, nanos: 999 }))
      .toBe("2026-10-15T01:02:03.000Z");
  });
});
