import { describe, it, expect } from "vitest";
import { buildTurnContext, CONTEXT_ITEM_CAP } from "../../src/agent/context.js";
import { makeTestDeps } from "../helpers/deps.js";
import { makeItem } from "../store/contract.js";

describe("buildTurnContext", () => {
  it("states the SGT time with weekday, the list numbering and open items", async () => {
    const deps = makeTestDeps();
    const a = await deps.store.items.create(makeItem({ title: "Consent form", dedupeKey: "a", dueAt: "2026-10-15T07:00:00.000Z" }));
    const b = await deps.store.items.create(makeItem({ title: "Math worksheet", dedupeKey: "b" }));
    await deps.store.items.create(makeItem({ title: "Finished", dedupeKey: "c", status: "done" }));
    await deps.store.items.create(makeItem({ title: "Later", dedupeKey: "d", status: "snoozed", snoozedUntil: "2026-10-20T00:00:00.000Z" }));
    await deps.store.state.set("lastList", { at: "2026-10-13T22:30:00.000Z", map: { "2": b.id, "1": a.id } });

    const ctx = await buildTurnContext(deps, deps.clock.now());
    expect(ctx).toContain("Now: Wed 14 Oct, 8am SGT (2026-10-14T08:00:00+08:00)");
    expect(ctx).toContain("Current list numbering (last list shown to the user, Wed 14 Oct, 6:30am):\n1. Consent form");
    expect(ctx).toContain(`2. Math worksheet · school email from Mr Tan <tan@school.edu.sg> · id=${b.id}`);
    expect(ctx).toContain(`- [#1] Consent form · due Thu 15 Oct, 3pm`);
    expect(ctx).toContain("Open items (2, soonest due first):");
    expect(ctx).not.toContain("Finished");
    expect(ctx).toContain("Snoozed and hidden for now: 1");
  });

  it("shows done items in the numbering, flags deleted ones, and says when there is no list", async () => {
    const deps = makeTestDeps();
    expect(await buildTurnContext(deps, deps.clock.now())).toContain("Current list numbering: none yet.");
    const done = await deps.store.items.create(makeItem({ title: "Already done", dedupeKey: "a", status: "done" }));
    await deps.store.state.set("lastList", { at: "2026-10-14T00:00:00.000Z", map: { "1": done.id, "2": "gone" } });
    const ctx = await buildTurnContext(deps, deps.clock.now());
    expect(ctx).toContain("1. Already done · done ·");
    expect(ctx).toContain("2. (item no longer exists) id=gone");
  });

  it(`caps the open-item snapshot at ${CONTEXT_ITEM_CAP}`, async () => {
    const deps = makeTestDeps();
    for (let i = 0; i < 40; i++) await deps.store.items.create(makeItem({ title: `Task ${i}`, dedupeKey: `k${i}` }));
    const ctx = await buildTurnContext(deps, deps.clock.now());
    expect(ctx).toContain("Open items (40, soonest due first, first 30 shown):");
    expect(ctx.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(30);
  });
});
