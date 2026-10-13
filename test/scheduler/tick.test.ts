import { describe, it, expect } from "vitest";
import { tick } from "../../src/scheduler/tick.js";
import { EMPTY_SYNC } from "../../src/ports.js";
import type { Item } from "../../src/types.js";
import { fakeClassroom, fakeMail, makeSchedulerDeps } from "../helpers/scheduler-fakes.js";
import { makeItem } from "../store/contract.js";

const WED_1000 = "2026-10-14T02:00:00.000Z";
const MORNING_SENT = { lastMorningDate: "2026-10-14", lastEveningDate: null };

describe("tick", () => {
  it("runs every step in order and reports each one", async () => {
    const calls: string[] = [];
    const { deps, outbox } = makeSchedulerDeps(WED_1000, {
      mail: fakeMail({
        syncAccount: async (a) => { calls.push(`sync:${a}`); return EMPTY_SYNC; },
        retryPendingTriage: async () => { calls.push("retry"); return EMPTY_SYNC; },
        renewWatchIfNeeded: async (a) => { calls.push(`watch:${a}`); },
      }),
      classroom: fakeClassroom({ syncIfDue: async () => { calls.push("classroom"); return EMPTY_SYNC; } }),
    });
    await deps.store.state.set("briefs", MORNING_SENT);

    const report = await tick(deps);

    expect(Object.keys(report)).toEqual([
      "sync:personal", "sync:school", "retryTriage", "classroom", "alerts", "wakeSnoozed", "reminders",
      "nudges", "brief:morning", "brief:evening", "outboxFlush", "watch:personal", "watch:school", "purge",
    ]);
    expect(report).toEqual({
      "sync:personal": "ok", "sync:school": "ok", retryTriage: "ok", classroom: "ok", alerts: "skipped",
      wakeSnoozed: "skipped", reminders: "skipped", nudges: "skipped", "brief:morning": "skipped",
      "brief:evening": "skipped", outboxFlush: "ok", "watch:personal": "ok", "watch:school": "ok", purge: "ok",
    });
    expect(calls).toEqual(["sync:personal", "sync:school", "retry", "classroom", "watch:personal", "watch:school"]);
    expect(outbox.flushes).toBe(1);
    expect(outbox.sent).toEqual([]);
  });

  it("a failing step is reported and the rest still run", async () => {
    const watched: string[] = [];
    const { deps } = makeSchedulerDeps(WED_1000, {
      mail: fakeMail({
        syncAccount: async (a) => {
          if (a === "school") throw new Error("school sync exploded");
          return EMPTY_SYNC;
        },
        renewWatchIfNeeded: async (a) => { watched.push(a); },
      }),
    });
    await deps.store.state.set("briefs", MORNING_SENT);
    const report = await tick(deps);
    expect(report["sync:school"]).toEqual({ error: "school sync exploded" });
    expect(report["sync:personal"]).toBe("ok");
    expect(report.purge).toBe("ok");
    expect(watched).toEqual(["personal", "school"]);
  });

  it("alerts from sync, retry and classroom go out as one grouped message", async () => {
    let a!: Item;
    let b!: Item;
    const { deps, outbox } = makeSchedulerDeps(WED_1000, {
      mail: fakeMail({ syncAccount: async (acc) => (acc === "personal" ? { ...EMPTY_SYNC, alerts: [a] } : EMPTY_SYNC) }),
      classroom: fakeClassroom({ syncIfDue: async () => ({ ...EMPTY_SYNC, alerts: [b] }) }),
    });
    a = await deps.store.items.create(makeItem({ title: "Reply to Mr Tan", urgency: "urgent", dedupeKey: "a" }));
    b = await deps.store.items.create(makeItem({ title: "Maths quiz moved", urgency: "urgent", dedupeKey: "b" }));
    await deps.store.state.set("briefs", MORNING_SENT);

    const report = await tick(deps);

    expect(report.alerts).toBe("ok");
    const alerts = outbox.sent.filter((m) => m.kind === "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain("Reply to Mr Tan");
    expect(alerts[0]?.text).toContain("Maths quiz moved");
  });

  it("an alert during quiet hours is held, then lands in the next morning brief", async () => {
    let pending: Item[] = [];
    const { deps, outbox } = makeSchedulerDeps("2026-10-14T15:00:00.000Z", { // Wed 23:00 SGT
      mail: fakeMail({
        syncAccount: async (acc) => {
          if (acc !== "personal") return EMPTY_SYNC;
          const alerts = pending;
          pending = [];
          return { ...EMPTY_SYNC, alerts };
        },
      }),
    });
    await deps.store.state.set("briefs", { lastMorningDate: "2026-10-14", lastEveningDate: "2026-10-14" });
    const camp = await deps.store.items.create(makeItem({ title: "Camp form", urgency: "urgent", dedupeKey: "camp" }));
    pending = [camp];

    const night = await tick(deps);
    expect(night.alerts).toBe("ok");
    expect(outbox.sent).toEqual([]);

    deps.clock.set("2026-10-14T22:30:00.000Z"); // Thu 06:30 SGT
    const morning = await tick(deps);
    expect(morning["brief:morning"]).toBe("ok");
    expect(outbox.sent.map((m) => m.kind)).toEqual(["morning"]);
    expect(outbox.sent[0]?.text).toContain("*Good morning! Thu 15 Oct* ☀️");
    expect(outbox.sent[0]?.text).toContain("*🌙 Came in overnight*\n1. Camp form · Mr Tan");
    expect((await deps.store.items.get(camp.id))?.alertedAt).toBe("2026-10-14T22:29:59.999Z"); // just before 06:30, see maybeSendBrief
  });

  it("reminders fire even in quiet hours and are marked sent", async () => {
    const { deps, outbox } = makeSchedulerDeps("2026-10-14T15:00:00.000Z"); // Wed 23:00 SGT
    await deps.store.state.set("briefs", { lastMorningDate: "2026-10-14", lastEveningDate: "2026-10-14" });
    const base = { status: "pending" as const, itemId: null, createdAt: "2026-10-14T10:00:00.000Z" };
    await deps.store.reminders.create({ ...base, text: "Pack PE kit", fireAt: "2026-10-14T14:55:00.000Z" });
    await deps.store.reminders.create({ ...base, text: "Later", fireAt: "2026-10-15T01:00:00.000Z" });

    const report = await tick(deps);

    expect(report.reminders).toBe("ok");
    expect(outbox.sent).toEqual([{
      kind: "reminder", text: "⏰ Pack PE kit", template: { name: "heads_up", params: ["Reminder: Pack PE kit"] },
    }]);
    expect((await deps.store.reminders.listPending()).map((r) => r.text)).toEqual(["Later"]);
  });

  it("snoozed + overdue item stays hidden until woken, then shows as overdue and is never nudged", async () => {
    const now = "2026-10-13T22:30:00.000Z"; // Wed 06:30 SGT
    const { deps, outbox } = makeSchedulerDeps(now);
    const chem = await deps.store.items.create(makeItem({ title: "Chem practical write-up", dedupeKey: "chem",
      dueAt: "2026-10-12T15:59:00.000Z", status: "snoozed", snoozedUntil: "2026-10-13T22:00:00.000Z" }));
    const art = await deps.store.items.create(makeItem({ title: "Art portfolio", dedupeKey: "art",
      dueAt: "2026-10-12T15:59:00.000Z", status: "snoozed", snoozedUntil: "2026-10-16T00:00:00.000Z" }));

    const report = await tick(deps);

    expect(report.wakeSnoozed).toBe("ok");
    expect(await deps.store.items.get(chem.id)).toMatchObject({ status: "open", snoozedUntil: null });
    expect((await deps.store.items.get(art.id))?.status).toBe("snoozed");
    const brief = outbox.sent.find((m) => m.kind === "morning");
    expect(brief?.text).toContain("*⚠️ Overdue*\n1. Chem practical write-up (was due Mon) · Mr Tan");
    expect(brief?.text).not.toContain("Art portfolio");
    expect(outbox.sent.some((m) => m.kind === "nudge")).toBe(false);
  });

  it("purges processed keys older than 7 days", async () => {
    const { deps } = makeSchedulerDeps(WED_1000);
    await deps.store.state.set("briefs", MORNING_SENT);
    await deps.store.processed.claim("old", "2026-10-01T00:00:00.000Z");
    await deps.store.processed.claim("recent", "2026-10-13T00:00:00.000Z");
    await tick(deps);
    expect(await deps.store.processed.claim("old", WED_1000)).toBe(true);
    expect(await deps.store.processed.claim("recent", WED_1000)).toBe(false);
  });
});
