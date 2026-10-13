import { describe, it, expect } from "vitest";
import { createNotifier } from "../../src/notify/notifier.js";
import { heldAlertIds } from "../../src/notify/held.js";
import { makeTestDeps } from "../helpers/deps.js";
import { recordingOutbox } from "../helpers/scheduler-fakes.js";
import { makeItem } from "../store/contract.js";

const WED_0800 = "2026-10-14T00:00:00.000Z";
const WED_2300 = "2026-10-14T15:00:00.000Z"; // quiet hours

function setup(nowIso = WED_0800) {
  const outbox = recordingOutbox();
  const deps = makeTestDeps({ outbox });
  deps.clock.set(nowIso);
  return { deps, outbox, notifier: createNotifier(deps) };
}

describe("Notifier.sendAlerts", () => {
  it("does nothing for an empty list", async () => {
    const deps = makeTestDeps(); // outbox stub throws if touched
    await expect(createNotifier(deps).sendAlerts([])).resolves.toBeUndefined();
  });

  it("groups items into one numbered message, saves lastList and marks them alerted", async () => {
    const { deps, outbox, notifier } = setup();
    const a = await deps.store.items.create(makeItem({
      title: "Submit CCA consent form", dueAt: "2026-10-14T07:00:00.000Z", urgency: "urgent", dedupeKey: "a",
    }));
    const b = await deps.store.items.create(makeItem({ title: "Chem test moved to Friday", dedupeKey: "b" }));
    await notifier.sendAlerts([b, a]);
    expect(outbox.sent).toEqual([{
      kind: "alert",
      text: `⚠️ *Heads up*\n1. Submit CCA consent form · due today 3pm · Mr Tan\n2. Chem test moved to Friday · Mr Tan\n\n_Reply "done 1" when it's sorted._`,
      template: { name: "heads_up", params: ["2 things: Submit CCA consent form; Chem test moved to Friday"] },
    }]);
    expect(await deps.store.state.get("lastList")).toEqual({ at: WED_0800, map: { "1": a.id, "2": b.id } });
    expect((await deps.store.items.get(a.id))?.alertedAt).toBe(WED_0800);
    expect((await deps.store.items.get(b.id))?.alertedAt).toBe(WED_0800);
  });

  it("a single item's summary is its title, cut to 60 characters", async () => {
    const { deps, outbox, notifier } = setup();
    const a = await deps.store.items.create(makeItem({ title: `Urgent ${"x".repeat(80)}`, dedupeKey: "a" }));
    await notifier.sendAlerts([a]);
    const summary = outbox.sent[0]?.template.params[0] ?? "";
    expect(summary).toHaveLength(60);
    expect(summary.startsWith("Urgent xxx")).toBe(true);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("drops items that were closed or already alerted since the sync", async () => {
    const { deps, outbox, notifier } = setup();
    const done = await deps.store.items.create(makeItem({ title: "Done one", dedupeKey: "d" }));
    const alerted = await deps.store.items.create(makeItem({ title: "Alerted one", dedupeKey: "al" }));
    await deps.store.items.update(done.id, { status: "done" });
    await deps.store.items.update(alerted.id, { alertedAt: "2026-10-13T23:00:00.000Z" });
    await notifier.sendAlerts([done, alerted]); // stale snapshots still say open/un-alerted
    expect(outbox.sent).toEqual([]);
  });

  it("holds alerts during quiet hours instead of sending", async () => {
    const { deps, outbox, notifier } = setup(WED_2300);
    const a = await deps.store.items.create(makeItem({ urgency: "urgent", dedupeKey: "a" }));
    await notifier.sendAlerts([a]);
    await notifier.sendAlerts([a]); // a second sync reporting the same item
    expect(outbox.sent).toEqual([]);
    expect((await deps.store.items.get(a.id))?.alertedAt).toBeNull();
    expect(await heldAlertIds(deps.store)).toEqual([a.id]);
  });

  it("on delivery failure, holds the items for the next brief and rethrows", async () => {
    const deps = makeTestDeps({
      outbox: { deliver: async () => { throw new Error("graph 500"); }, flush: async () => 0 },
    });
    const a = await deps.store.items.create(makeItem({ urgency: "urgent", dedupeKey: "a" }));
    await expect(createNotifier(deps).sendAlerts([a])).rejects.toThrow("graph 500");
    expect((await deps.store.items.get(a.id))?.alertedAt).toBeNull();
    expect(await heldAlertIds(deps.store)).toEqual([a.id]);
  });

  it("caps a large batch at 8 lines", async () => {
    const { deps, outbox, notifier } = setup();
    const items = [];
    for (let k = 0; k < 12; k++) {
      items.push(await deps.store.items.create(makeItem({ title: `Thing ${k}`, dedupeKey: `k${k}`,
        createdAt: `2026-10-13T0${Math.floor(k / 10)}:${String(k % 10).padStart(2, "0")}:00.000Z` })));
    }
    await notifier.sendAlerts(items);
    const text = outbox.sent[0]?.text ?? "";
    expect(text).toContain("8. Thing 7");
    expect(text).not.toContain("9. ");
    expect(text).toContain("_…and 4 more. Ask me to list them._");
    expect(Object.keys((await deps.store.state.get("lastList"))?.map ?? {})).toHaveLength(8);
    for (const i of items) expect((await deps.store.items.get(i.id))?.alertedAt).toBe(WED_0800);
  });
});
