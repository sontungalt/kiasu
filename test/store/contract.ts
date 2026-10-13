import { describe, it, expect, beforeEach } from "vitest";
import type { Store } from "../../src/store/types.js";
import type { Item } from "../../src/types.js";
import { DEFAULT_SETTINGS } from "../../src/types.js";

export function makeItem(over: Partial<Omit<Item, "id">> = {}): Omit<Item, "id"> {
  return {
    type: "task", title: "Submit consent form", details: null,
    dueAt: null, startAt: null, endAt: null, urgency: "normal", urgencyReason: null,
    status: "open", snoozedUntil: null, nudgedAt: null, alertedAt: null,
    source: { kind: "email", account: "school", emailId: "m1", threadId: "t1", from: "Mr Tan <tan@school.edu.sg>" },
    dedupeKey: "t1:submit consent form",
    createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z",
    ...over,
  };
}

export function runStoreContract(name: string, makeStore: () => Promise<Store>) {
  describe(`Store contract: ${name}`, () => {
    let store: Store;
    beforeEach(async () => {
      store = await makeStore();
    });

    it("claim is once-only", async () => {
      expect(await store.processed.claim("wa:abc/1", "2026-10-14T00:00:00.000Z")).toBe(true);
      expect(await store.processed.claim("wa:abc/1", "2026-10-14T00:00:01.000Z")).toBe(false);
      const results = await Promise.all([1, 2, 3].map(() => store.processed.claim("ps:race", "2026-10-14T00:00:00.000Z")));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("purges old processed keys", async () => {
      await store.processed.claim("old", "2026-10-01T00:00:00.000Z");
      await store.processed.claim("new", "2026-10-14T00:00:00.000Z");
      expect(await store.processed.purgeOlderThan("2026-10-07T00:00:00.000Z")).toBe(1);
      expect(await store.processed.claim("old", "2026-10-14T00:00:00.000Z")).toBe(true);
    });

    it("items create/get/update/findByDedupeKey/listByThread", async () => {
      const created = await store.items.create(makeItem());
      expect(created.id).toBeTruthy();
      expect(await store.items.findByDedupeKey("t1:submit consent form")).toMatchObject({ id: created.id });
      await store.items.update(created.id, { status: "done" });
      expect((await store.items.get(created.id))?.status).toBe("done");
      expect(await store.items.listByThread("t1")).toHaveLength(1);
      expect(await store.items.findByDedupeKey("nope")).toBeNull();
    });

    it("items.list filters and sorts", async () => {
      await store.items.create(makeItem({ title: "B later", dedupeKey: "b", dueAt: "2026-10-16T00:00:00.000Z" }));
      await store.items.create(makeItem({ title: "A sooner", dedupeKey: "a", dueAt: "2026-10-15T00:00:00.000Z" }));
      await store.items.create(makeItem({ title: "C undated", dedupeKey: "c" }));
      await store.items.create(makeItem({ title: "D done", dedupeKey: "d", status: "done" }));
      await store.items.create(makeItem({ title: "E personal", dedupeKey: "e",
        source: { kind: "email", account: "personal", emailId: "m2", threadId: "t2", from: "x" } }));
      const open = await store.items.list({ status: ["open"], account: "school" });
      expect(open.map((i) => i.title)).toEqual(["A sooner", "B later", "C undated"]);
      const dueBefore = await store.items.list({ status: ["open"], dueBefore: "2026-10-15T12:00:00.000Z" });
      expect(dueBefore.map((i) => i.title)).toEqual(["A sooner"]);
      expect(await store.items.list({ query: "LATER" })).toHaveLength(1);
      expect(await store.items.list({ status: ["open"], limit: 1 })).toHaveLength(1);
    });

    it("emails pending and important-since", async () => {
      const base = {
        account: "school" as const, threadId: "t", from: "f", subject: "s", summary: null, category: null,
        importance: null, needsReply: false, triageAttempts: 0, processedAt: null,
      };
      await store.emails.upsert({ ...base, id: "p2", receivedAt: "2026-10-14T02:00:00.000Z", triageStatus: "pending" });
      await store.emails.upsert({ ...base, id: "p1", receivedAt: "2026-10-14T01:00:00.000Z", triageStatus: "pending" });
      await store.emails.upsert({ ...base, id: "d1", receivedAt: "2026-10-14T01:00:00.000Z", triageStatus: "done",
        importance: "high", processedAt: "2026-10-14T03:00:00.000Z" });
      await store.emails.upsert({ ...base, id: "d2", receivedAt: "2026-10-14T01:00:00.000Z", triageStatus: "done",
        importance: "low", processedAt: "2026-10-14T03:00:00.000Z" });
      expect((await store.emails.listPending(10)).map((e) => e.id)).toEqual(["p1", "p2"]);
      expect((await store.emails.listImportantSince("2026-10-14T00:00:00.000Z")).map((e) => e.id)).toEqual(["d1"]);
      expect(await store.emails.get("p1")).toMatchObject({ id: "p1" });
    });

    it("emails failed-since", async () => {
      const base = {
        account: "school" as const, threadId: "t", from: "f", subject: "s", summary: null, category: null,
        importance: null, needsReply: false, triageAttempts: 5, receivedAt: "2026-10-14T01:00:00.000Z",
      };
      await store.emails.upsert({ ...base, id: "f1", triageStatus: "failed", processedAt: "2026-10-14T03:00:00.000Z" });
      await store.emails.upsert({ ...base, id: "f2", triageStatus: "failed", processedAt: "2026-10-14T04:00:00.000Z",
        receivedAt: "2026-10-14T02:00:00.000Z" });
      await store.emails.upsert({ ...base, id: "f0", triageStatus: "failed", processedAt: "2026-10-12T03:00:00.000Z" });
      await store.emails.upsert({ ...base, id: "d1", triageStatus: "done", processedAt: "2026-10-14T03:00:00.000Z" });
      expect((await store.emails.listFailedSince("2026-10-14T00:00:00.000Z")).map((e) => e.id)).toEqual(["f2", "f1"]);
    });

    it("reminders listDue", async () => {
      const r = await store.reminders.create({ text: "x", fireAt: "2026-10-14T12:00:00.000Z", status: "pending", itemId: null, createdAt: "2026-10-14T00:00:00.000Z" });
      expect(await store.reminders.listDue("2026-10-14T11:59:59.000Z")).toHaveLength(0);
      expect(await store.reminders.listDue("2026-10-14T12:00:00.000Z")).toHaveLength(1);
      await store.reminders.update(r.id, { status: "sent" });
      expect(await store.reminders.listDue("2026-10-15T00:00:00.000Z")).toHaveLength(0);
    });

    it("conversation recent returns oldest-first last n", async () => {
      for (let i = 0; i < 5; i++) {
        await store.conversation.append({ role: i % 2 ? "assistant" : "user", text: `m${i}`, at: `2026-10-14T00:00:0${i}.000Z` });
      }
      expect((await store.conversation.recent(3)).map((t) => t.text)).toEqual(["m2", "m3", "m4"]);
    });

    it("outbox pending lifecycle", async () => {
      const m = await store.outbox.create({ kind: "morning", text: "hi", template: { name: "brief_ready", params: ["Tue", "1", "0"] },
        status: "pending", attempts: 0, lastError: null, createdAt: "2026-10-14T00:00:00.000Z", sentAt: null });
      expect(await store.outbox.listPending()).toHaveLength(1);
      await store.outbox.update(m.id, { status: "sent", sentAt: "2026-10-14T00:01:00.000Z" });
      expect(await store.outbox.listPending()).toHaveLength(0);
    });

    it("state and settings", async () => {
      expect(await store.state.get("whatsapp")).toBeNull();
      await store.state.set("whatsapp", { lastInboundAt: "2026-10-14T00:00:00.000Z" });
      expect(await store.state.get("whatsapp")).toEqual({ lastInboundAt: "2026-10-14T00:00:00.000Z" });
      expect(await store.settings.get()).toEqual(DEFAULT_SETTINGS);
    });

    it("accounts upsert/get", async () => {
      expect(await store.accounts.get("school")).toBeNull();
      const acc = { id: "school" as const, email: "a@b.c", historyId: "1", watchExpiresAt: null, lastSyncAt: null, authStatus: "ok" as const };
      await store.accounts.upsert(acc);
      expect(await store.accounts.get("school")).toEqual(acc);
    });
  });
}
