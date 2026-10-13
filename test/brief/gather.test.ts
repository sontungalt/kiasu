import { describe, it, expect } from "vitest";
import { gatherBriefInput, healthLines, CALENDAR_DOWN } from "../../src/brief/gather.js";
import { addHeldAlerts } from "../../src/notify/held.js";
import { makeTestDeps } from "../helpers/deps.js";
import { fakeCalendar } from "../helpers/scheduler-fakes.js";
import { makeItem } from "../store/contract.js";
import type { AccountState } from "../../src/types.js";
import { MORNING, EVENING, email, event } from "./fixtures.js";

const account = (over: Partial<AccountState> & Pick<AccountState, "id">): AccountState => ({
  email: `${over.id}@example.com`, historyId: "1", watchExpiresAt: null,
  lastSyncAt: "2026-10-13T22:25:00.000Z", authStatus: "ok", ...over,
});

describe("gatherBriefInput", () => {
  it("morning: today's events, open items, emails since yesterday's morning brief", async () => {
    const calendar = fakeCalendar([event("assembly")]);
    const deps = makeTestDeps({ calendar });
    const open = await deps.store.items.create(makeItem({ title: "Open", dedupeKey: "o" }));
    await deps.store.items.create(makeItem({ title: "Done", dedupeKey: "d", status: "done" }));
    await deps.store.items.create(makeItem({ title: "Snoozed", dedupeKey: "s", status: "snoozed",
      snoozedUntil: "2026-10-20T00:00:00.000Z" }));
    await deps.store.emails.upsert(email("new", { processedAt: "2026-10-13T01:00:00.000Z" }));
    await deps.store.emails.upsert(email("old", { processedAt: "2026-10-12T20:00:00.000Z" }));
    await deps.store.emails.upsert(email("bad", { triageStatus: "failed", summary: null, processedAt: "2026-10-13T10:00:00.000Z" }));

    const input = await gatherBriefInput(deps, "morning", MORNING);

    expect(calendar.calls).toEqual([["2026-10-13T16:00:00.000Z", "2026-10-14T16:00:00.000Z"]]);
    expect(input.sinceIso).toBe("2026-10-12T22:30:00.000Z");
    expect(input.openItems.map((i) => i.id)).toEqual([open.id]);
    expect(input.importantEmails.map((e) => e.id)).toEqual(["new"]);
    expect(input.failedEmails.map((e) => e.id)).toEqual(["bad"]);
    expect(input.events.map((e) => e.id)).toEqual(["assembly"]);
    expect(input.overnightAlerts).toEqual([]);
    expect(input.health).toEqual([]);
  });

  it("evening: tomorrow's events, since this morning", async () => {
    const calendar = fakeCalendar();
    const deps = makeTestDeps({ calendar });
    const input = await gatherBriefInput(deps, "evening", EVENING);
    expect(calendar.calls).toEqual([["2026-10-14T16:00:00.000Z", "2026-10-15T16:00:00.000Z"]]);
    expect(input.sinceIso).toBe("2026-10-13T22:30:00.000Z");
  });

  it("a calendar failure gives empty events and a health line, never an error", async () => {
    const deps = makeTestDeps({ calendar: { listEvents: async () => { throw new Error("403 forbidden"); } } });
    const input = await gatherBriefInput(deps, "morning", MORNING);
    expect(input.events).toEqual([]);
    expect(input.health).toEqual([CALENDAR_DOWN]);
  });

  it("overnight alerts are held items that are still open and un-alerted", async () => {
    const deps = makeTestDeps({ calendar: fakeCalendar() });
    const open = await deps.store.items.create(makeItem({ title: "Held", dedupeKey: "h" }));
    const done = await deps.store.items.create(makeItem({ title: "Closed", dedupeKey: "c", status: "done" }));
    const sent = await deps.store.items.create(makeItem({ title: "Sent", dedupeKey: "s", alertedAt: "2026-10-13T23:00:00.000Z" }));
    await addHeldAlerts(deps.store, [open.id, done.id, sent.id]);
    const input = await gatherBriefInput(deps, "morning", MORNING);
    expect(input.overnightAlerts.map((i) => i.id)).toEqual([open.id]);
  });
});

describe("healthLines", () => {
  it("reports a stale inbox, a revoked account and stuck WhatsApp messages", async () => {
    const deps = makeTestDeps();
    await deps.store.accounts.upsert(account({ id: "personal", lastSyncAt: "2026-10-13T19:00:00.000Z" })); // 03:00 SGT
    await deps.store.accounts.upsert(account({ id: "school", authStatus: "revoked" }));
    const msg = { kind: "alert" as const, text: "x", template: null, status: "pending" as const,
      createdAt: "2026-10-13T20:00:00.000Z", sentAt: null };
    await deps.store.outbox.create({ ...msg, attempts: 3, lastError: "131047" });
    await deps.store.outbox.create({ ...msg, attempts: 0, lastError: null }); // just waiting for the window
    expect(await healthLines(deps.store, MORNING)).toEqual([
      '⚠️ Personal inbox not synced since 3am. Reply "status" for details.',
      "⚠️ School account disconnected. Run `npm run auth -- school` to reconnect.",
      '⚠️ 1 WhatsApp message couldn\'t be sent. Reply "status" for details.',
    ]);
  });

  it("is quiet when syncs are fresh; names the day when the last sync was yesterday", async () => {
    const deps = makeTestDeps();
    await deps.store.accounts.upsert(account({ id: "personal" }));
    expect(await healthLines(deps.store, MORNING)).toEqual([]);
    await deps.store.accounts.upsert(account({ id: "school", lastSyncAt: "2026-10-13T06:05:00.000Z" })); // Tue 14:05 SGT
    expect(await healthLines(deps.store, MORNING)).toEqual([
      '⚠️ School inbox not synced since Tue 13 Oct, 2:05pm. Reply "status" for details.',
    ]);
  });
});
