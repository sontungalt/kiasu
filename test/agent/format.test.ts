import { describe, it, expect } from "vitest";
import { sgtIso, parseToolTime, isActive, describeItem } from "../../src/agent/format.js";
import { makeItem } from "../store/contract.js";

describe("agent format helpers", () => {
  it("sgtIso renders SGT wall clock with +08:00", () => {
    expect(sgtIso(new Date("2026-10-14T00:00:00Z"))).toBe("2026-10-14T08:00:00+08:00");
    expect(sgtIso(new Date("2026-10-14T16:30:00Z"))).toBe("2026-10-15T00:30:00+08:00");
  });

  it("parseToolTime honours offsets and reads offset-less times as SGT", () => {
    expect(parseToolTime("2026-10-14T20:00:00+08:00")?.toISOString()).toBe("2026-10-14T12:00:00.000Z");
    expect(parseToolTime("2026-10-14T12:00:00Z")?.toISOString()).toBe("2026-10-14T12:00:00.000Z");
    // No offset: must be SGT, not the server's (UTC) zone.
    expect(parseToolTime("2026-10-14T20:00:00")?.toISOString()).toBe("2026-10-14T12:00:00.000Z");
    expect(parseToolTime("2026-10-14T20:00")?.toISOString()).toBe("2026-10-14T12:00:00.000Z");
    // Bare date: 23:59 SGT that day.
    expect(parseToolTime("2026-10-17")?.toISOString()).toBe("2026-10-17T15:59:00.000Z");
    expect(parseToolTime("tomorrow 8pm")).toBeNull();
    expect(parseToolTime("")).toBeNull();
  });

  it("isActive: open, or snoozed with the snooze over", () => {
    const now = new Date("2026-10-14T00:00:00Z");
    expect(isActive({ ...makeItem(), id: "a" }, now)).toBe(true);
    expect(isActive({ ...makeItem({ status: "snoozed", snoozedUntil: "2026-10-15T00:00:00.000Z" }), id: "b" }, now)).toBe(false);
    expect(isActive({ ...makeItem({ status: "snoozed", snoozedUntil: "2026-10-13T00:00:00.000Z" }), id: "c" }, now)).toBe(true);
    expect(isActive({ ...makeItem({ status: "done" }), id: "d" }, now)).toBe(false);
  });

  it("describeItem shows SGT due time, urgency, source and id", () => {
    const line = describeItem({ ...makeItem({ dueAt: "2026-10-15T07:00:00.000Z", urgency: "urgent" }), id: "i1" });
    expect(line).toBe("Submit consent form · due Thu 15 Oct, 3pm · URGENT · school email from Mr Tan <tan@school.edu.sg> · id=i1");
  });
});
