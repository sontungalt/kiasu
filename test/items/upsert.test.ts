import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "../../src/store/memory.js";
import { upsertItem, normaliseTitle, emailDedupeKey, type ItemDraft } from "../../src/items/upsert.js";

const NOW = new Date("2026-10-14T00:00:00Z");

function draft(over: Partial<ItemDraft> = {}): ItemDraft {
  return {
    type: "deadline", title: "Submit CCA consent form", details: null,
    dueAt: "2026-10-15T15:00:00+08:00", startAt: null, endAt: null,
    urgency: "normal", urgencyReason: null,
    source: { kind: "email", account: "school", emailId: "m1", threadId: "t1", from: "Mr Tan <tan@school.edu.sg>" },
    dedupeKey: emailDedupeKey("t1", "Submit CCA consent form"),
    ...over,
  };
}

describe("normaliseTitle", () => {
  it("strips prefixes, punctuation and case", () => {
    expect(normaliseTitle("RE: Fwd: Reminder: Submit the CCA consent-form!!")).toBe("submit the cca consent form");
  });
});

describe("upsertItem", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it("creates an open item and stores UTC (upsert stores UTC)", async () => {
    const r = await upsertItem(store, draft(), NOW);
    expect(r.change).toBe("created");
    expect(r.item.status).toBe("open");
    expect(r.item.dueAt).toBe("2026-10-15T07:00:00.000Z");
    expect(r.item.createdAt).toBe(NOW.toISOString());
  });

  it("same dedupe key with nothing new is unchanged", async () => {
    await upsertItem(store, draft(), NOW);
    const r = await upsertItem(store, draft(), NOW);
    expect(r.change).toBe("unchanged");
    expect(await store.items.list({})).toHaveLength(1);
  });

  it("same thread + similar title updates instead of creating", async () => {
    await upsertItem(store, draft(), NOW);
    const r = await upsertItem(store, draft({
      title: "Reminder: submit CCA consent form",
      dedupeKey: emailDedupeKey("t1", "Reminder: submit CCA consent form tomorrow"),
      source: { kind: "email", account: "school", emailId: "m2", threadId: "t1", from: "Mr Tan <tan@school.edu.sg>" },
    }), NOW);
    expect(r.change).toBe("unchanged");
    expect(await store.items.list({})).toHaveLength(1);
  });

  it("due change updates, flags dueChanged, resets alertedAt/nudgedAt", async () => {
    const first = await upsertItem(store, draft(), NOW);
    await store.items.update(first.item.id, { alertedAt: NOW.toISOString(), nudgedAt: NOW.toISOString() });
    const r = await upsertItem(store, draft({ dueAt: "2026-10-16T15:00:00+08:00" }), NOW);
    expect(r).toMatchObject({ change: "updated", dueChanged: true });
    expect(r.item.dueAt).toBe("2026-10-16T07:00:00.000Z");
    expect(r.item.alertedAt).toBeNull();
    expect(r.item.nudgedAt).toBeNull();
  });

  it("urgency only escalates", async () => {
    await upsertItem(store, draft({ urgency: "urgent", urgencyReason: "due tomorrow" }), NOW);
    const r = await upsertItem(store, draft({ urgency: "low" }), NOW);
    expect(r.item.urgency).toBe("urgent");
    expect(r.change).toBe("unchanged");
  });

  it("never reopens a done item", async () => {
    const first = await upsertItem(store, draft(), NOW);
    await store.items.update(first.item.id, { status: "done" });
    const r = await upsertItem(store, draft({ dueAt: "2026-10-17T15:00:00+08:00" }), NOW);
    expect(r.item.status).toBe("done");
  });

  it("different thread with same title creates a new item", async () => {
    await upsertItem(store, draft(), NOW);
    const r = await upsertItem(store, draft({
      dedupeKey: emailDedupeKey("t9", "Submit CCA consent form"),
      source: { kind: "email", account: "school", emailId: "m9", threadId: "t9", from: "x" },
    }), NOW);
    expect(r.change).toBe("created");
  });
});
