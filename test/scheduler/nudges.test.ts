import { describe, it, expect } from "vitest";
import { sendNudges } from "../../src/scheduler/nudges.js";
import { makeSchedulerDeps } from "../helpers/scheduler-fakes.js";
import { makeItem } from "../store/contract.js";

const WED_1400 = "2026-10-14T06:00:00.000Z";

describe("sendNudges", () => {
  it("nudges an item due within 3h exactly once", async () => {
    const { deps, outbox } = makeSchedulerDeps(WED_1400);
    const i = await deps.store.items.create(makeItem({ dueAt: "2026-10-14T08:00:00.000Z" })); // 16:00 SGT
    expect(await sendNudges(deps, new Date(WED_1400))).toBe("ok");
    expect(outbox.sent).toEqual([{
      kind: "nudge",
      text: "⏳ *Due soon*\n• Submit consent form · by 4pm · Mr Tan",
      template: { name: "heads_up", params: ["Submit consent form, due 4pm"] },
    }]);
    expect((await deps.store.items.get(i.id))?.nudgedAt).toBe(WED_1400);
    expect(await sendNudges(deps, new Date("2026-10-14T06:05:00.000Z"))).toBe("skipped");
    expect(outbox.sent).toHaveLength(1);
  });

  it("ignores overdue, too-far, closed and snoozed items; includes exactly-3h", async () => {
    const { deps, outbox } = makeSchedulerDeps(WED_1400);
    await deps.store.items.create(makeItem({ title: "Overdue", dedupeKey: "a", dueAt: "2026-10-14T05:00:00.000Z" }));
    await deps.store.items.create(makeItem({ title: "Exactly three hours", dedupeKey: "b", dueAt: "2026-10-14T09:00:00.000Z" }));
    await deps.store.items.create(makeItem({ title: "Too far", dedupeKey: "c", dueAt: "2026-10-14T09:01:00.000Z" }));
    await deps.store.items.create(makeItem({ title: "Closed", dedupeKey: "d", dueAt: "2026-10-14T07:00:00.000Z", status: "done" }));
    await deps.store.items.create(makeItem({ title: "Snoozed", dedupeKey: "e", dueAt: "2026-10-14T07:00:00.000Z",
      status: "snoozed", snoozedUntil: "2026-10-15T00:00:00.000Z" }));
    expect(await sendNudges(deps, new Date(WED_1400))).toBe("ok");
    expect(outbox.sent.map((m) => m.text)).toEqual(["⏳ *Due soon*\n• Exactly three hours · by 5pm · Mr Tan"]);
  });

  it("holds nudges in quiet hours and drops one whose deadline passes overnight", async () => {
    const night = "2026-10-14T14:45:00.000Z"; // Wed 22:45 SGT
    const { deps, outbox } = makeSchedulerDeps(night);
    const i = await deps.store.items.create(makeItem({ dueAt: "2026-10-14T15:30:00.000Z" })); // 23:30 SGT
    expect(await sendNudges(deps, new Date(night))).toBe("skipped");
    expect((await deps.store.items.get(i.id))?.nudgedAt).toBeNull();
    expect(await sendNudges(deps, new Date("2026-10-14T22:30:00.000Z"))).toBe("skipped"); // Thu 06:30, now overdue
    expect(outbox.sent).toEqual([]);
  });

  it("does not nudge an item that was just alerted, but records it as nudged", async () => {
    const { deps, outbox } = makeSchedulerDeps(WED_1400);
    const i = await deps.store.items.create(makeItem({ dueAt: "2026-10-14T08:00:00.000Z", alertedAt: "2026-10-14T05:30:00.000Z" }));
    expect(await sendNudges(deps, new Date(WED_1400))).toBe("skipped");
    expect(outbox.sent).toEqual([]);
    expect((await deps.store.items.get(i.id))?.nudgedAt).toBe(WED_1400);
  });

  it("groups several due-soon items into one message", async () => {
    const { deps, outbox } = makeSchedulerDeps(WED_1400);
    await deps.store.items.create(makeItem({ title: "First", dedupeKey: "a", dueAt: "2026-10-14T07:00:00.000Z" }));
    await deps.store.items.create(makeItem({ title: "Second", dedupeKey: "b", dueAt: "2026-10-14T08:00:00.000Z" }));
    expect(await sendNudges(deps, new Date(WED_1400))).toBe("ok");
    expect(outbox.sent).toEqual([{
      kind: "nudge",
      text: "⏳ *Due soon*\n• First · by 3pm · Mr Tan\n• Second · by 4pm · Mr Tan",
      template: { name: "heads_up", params: ["2 things due in the next 3h"] },
    }]);
  });
});
