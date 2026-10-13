import { describe, it, expect } from "vitest";
import { shouldAlert, senderEmailOf, isVip } from "../../src/items/alerts.js";
import type { UpsertResult } from "../../src/items/upsert.js";
import { DEFAULT_SETTINGS, type Item } from "../../src/types.js";
import { makeItem } from "../store/contract.js";

const NOW = new Date("2026-10-14T00:00:00Z");
const res = (over: Partial<Item>, change: UpsertResult["change"] = "created", dueChanged = false): UpsertResult =>
  ({ item: { ...makeItem(over), id: "i1" }, change, dueChanged });

describe("senderEmailOf / isVip", () => {
  it("parses addresses", () => {
    expect(senderEmailOf("Mr Tan <Tan@SCHOOL.edu.sg>")).toBe("tan@school.edu.sg");
    expect(senderEmailOf("tan@school.edu.sg")).toBe("tan@school.edu.sg");
    expect(senderEmailOf("Nobody")).toBeNull();
  });
  it("matches addresses and domains", () => {
    expect(isVip("tan@school.edu.sg", ["tan@school.edu.sg"])).toBe(true);
    expect(isVip("lim@school.edu.sg", ["@school.edu.sg"])).toBe(true);
    expect(isVip("lim@gmail.com", ["@school.edu.sg"])).toBe(false);
  });
});

describe("shouldAlert", () => {
  const ctx = { importance: "medium" as const, senderEmail: "x@y.z" };

  it("urgent new item alerts", () => {
    expect(shouldAlert(res({ urgency: "urgent" }), ctx, DEFAULT_SETTINGS, NOW)).toBe(true);
  });
  it("due within 36h + high importance alerts", () => {
    expect(shouldAlert(res({ dueAt: "2026-10-15T00:00:00.000Z" }), { ...ctx, importance: "high" }, DEFAULT_SETTINGS, NOW)).toBe(true);
  });
  it("due within 36h + medium importance does not alert", () => {
    expect(shouldAlert(res({ dueAt: "2026-10-15T00:00:00.000Z" }), ctx, DEFAULT_SETTINGS, NOW)).toBe(false);
  });
  it("VIP sender with medium importance alerts; low does not", () => {
    const s = { ...DEFAULT_SETTINGS, vipSenders: ["x@y.z"] };
    expect(shouldAlert(res({}), ctx, s, NOW)).toBe(true);
    expect(shouldAlert(res({}), { ...ctx, importance: "low" }, s, NOW)).toBe(false);
  });
  it("unchanged / non-due update / already alerted / not open never alert", () => {
    expect(shouldAlert(res({ urgency: "urgent" }, "unchanged"), ctx, DEFAULT_SETTINGS, NOW)).toBe(false);
    expect(shouldAlert(res({ urgency: "urgent" }, "updated", false), ctx, DEFAULT_SETTINGS, NOW)).toBe(false);
    expect(shouldAlert(res({ urgency: "urgent", alertedAt: NOW.toISOString() }), ctx, DEFAULT_SETTINGS, NOW)).toBe(false);
    expect(shouldAlert(res({ urgency: "urgent", status: "done" }), ctx, DEFAULT_SETTINGS, NOW)).toBe(false);
  });
  it("due date moved into the window alerts even at medium importance", () => {
    expect(shouldAlert(res({ dueAt: "2026-10-14T20:00:00.000Z" }, "updated", true), ctx, DEFAULT_SETTINGS, NOW)).toBe(true);
  });
  it("past-due items do not alert as due-soon", () => {
    expect(shouldAlert(res({ dueAt: "2026-10-13T00:00:00.000Z" }), { ...ctx, importance: "high" }, DEFAULT_SETTINGS, NOW)).toBe(false);
  });
});
