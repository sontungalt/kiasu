import { describe, it, expect, beforeEach } from "vitest";
import { buildTools, LIST_CAP, type AgentTool } from "../../src/agent/tools.js";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import { makeItem } from "../store/contract.js";
import { callTool, definitionOf } from "./helpers.js";

// The default test clock is 2026-10-14T00:00:00Z = Wed 14 Oct, 8am SGT.

describe("store-backed agent tools", () => {
  let deps: TestDeps;
  let tools: AgentTool[];
  const call = (name: string, input: unknown) => callTool(tools, name, input);

  beforeEach(() => {
    deps = makeTestDeps();
    tools = buildTools(deps);
  });

  it("every tool is strict with a closed object schema and no unsupported constraints", () => {
    for (const t of tools) {
      const def = definitionOf(t);
      expect(def.strict).toBe(true);
      expect(def.input_schema.type).toBe("object");
      expect(def.input_schema.additionalProperties).toBe(false);
      // Strict tool use rejects numeric/string constraints; z.number().int() would emit minimum/maximum.
      expect(JSON.stringify(def.input_schema)).not.toMatch(/"(minimum|maximum|minLength|maxLength)"/);
    }
  });

  describe("list_items", () => {
    it("lists open items soonest first and saves the numbering to lastList", async () => {
      const later = await deps.store.items.create(makeItem({ title: "Essay draft", dedupeKey: "b", dueAt: "2026-10-16T10:00:00.000Z" }));
      const sooner = await deps.store.items.create(makeItem({ title: "Consent form", dedupeKey: "a", dueAt: "2026-10-15T07:00:00.000Z" }));
      await deps.store.items.create(makeItem({ title: "Old done", dedupeKey: "c", status: "done" }));
      await deps.store.items.create(makeItem({ title: "Snoozed", dedupeKey: "d", status: "snoozed", snoozedUntil: "2026-10-20T00:00:00.000Z" }));

      const out = await call("list_items", {});
      expect(out).toContain("1. Consent form · due Thu 15 Oct, 3pm");
      expect(out).toContain("2. Essay draft · due Fri 16 Oct, 6pm");
      expect(out).not.toContain("Old done");
      expect(out).not.toContain("Snoozed");
      expect(await deps.store.state.get("lastList")).toEqual({
        at: "2026-10-14T00:00:00.000Z",
        map: { "1": sooner.id, "2": later.id },
      });
    });

    it("filters by due range (SGT input), account and query", async () => {
      await deps.store.items.create(makeItem({ title: "Due Thu", dedupeKey: "a", dueAt: "2026-10-15T07:00:00.000Z" }));
      await deps.store.items.create(makeItem({ title: "Due next week", dedupeKey: "b", dueAt: "2026-10-21T07:00:00.000Z" }));
      await deps.store.items.create(makeItem({ title: "Personal thing", dedupeKey: "c", dueAt: "2026-10-15T08:00:00.000Z",
        source: { kind: "email", account: "personal", emailId: "m9", threadId: "t9", from: "x" } }));

      const week = await call("list_items", { dueBefore: "2026-10-19T00:00:00+08:00" });
      expect(week).toContain("Due Thu");
      expect(week).not.toContain("Due next week");
      const school = await call("list_items", { account: "school", query: "due" });
      expect(school).not.toContain("Personal thing");
      expect(await call("list_items", { dueBefore: "next week" })).toMatch(/^Error: dueBefore/);
    });

    it(`caps at ${LIST_CAP} and says how many matched`, async () => {
      for (let i = 0; i < 35; i++) {
        await deps.store.items.create(makeItem({ title: `Task ${i}`, dedupeKey: `k${i}` }));
      }
      const out = await call("list_items", {});
      expect(out).toContain("35 items match; showing the first 30");
      expect(Object.keys((await deps.store.state.get("lastList"))!.map)).toHaveLength(30);
    });

    it("an empty result keeps the previous numbering", async () => {
      await deps.store.state.set("lastList", { at: "2026-10-13T22:30:00.000Z", map: { "1": "x" } });
      expect(await call("list_items", { query: "nothing matches" })).toMatch(/numbering is unchanged/);
      expect((await deps.store.state.get("lastList"))!.map).toEqual({ "1": "x" });
    });
  });

  describe("mark_item and ref resolution", () => {
    it("resolves a list number and names the item", async () => {
      const a = await deps.store.items.create(makeItem({ title: "Consent form", dedupeKey: "a" }));
      await deps.store.state.set("lastList", { at: "2026-10-13T22:30:00.000Z", map: { "1": a.id } });
      expect(await call("mark_item", { ref: "1", status: "done" })).toBe('Marked #1 "Consent form" as done.');
      expect((await deps.store.items.get(a.id))?.status).toBe("done");
    });

    it("'done 2' uses the newest numbering after a newer list replaced it", async () => {
      const a = await deps.store.items.create(makeItem({ title: "Brief item two", dedupeKey: "a" }));
      const b = await deps.store.items.create(makeItem({ title: "Chat list item two", dedupeKey: "b" }));
      await deps.store.state.set("lastList", { at: "2026-10-13T22:30:00.000Z", map: { "1": "zz", "2": a.id } });
      await deps.store.state.set("lastList", { at: "2026-10-14T00:00:00.000Z", map: { "1": "yy", "2": b.id } });
      expect(await call("mark_item", { ref: "2", status: "done" })).toBe('Marked #2 "Chat list item two" as done.');
      expect((await deps.store.items.get(a.id))?.status).toBe("open");
      expect((await deps.store.items.get(b.id))?.status).toBe("done");
    });

    it("accepts an item id and '#3' style refs", async () => {
      const a = await deps.store.items.create(makeItem({ title: "Form", dedupeKey: "a" }));
      expect(await call("mark_item", { ref: a.id, status: "dismissed" })).toBe('Marked "Form" as dismissed.');
      await deps.store.state.set("lastList", { at: "2026-10-14T00:00:00.000Z", map: { "3": a.id } });
      expect(await call("mark_item", { ref: "#3", status: "open" })).toBe('Marked #3 "Form" as open.');
      expect(await call("mark_item", { ref: "3", status: "open" })).toBe('#3 "Form" was already open. Nothing changed.');
    });

    it("unknown refs return recoverable errors and change nothing", async () => {
      expect(await call("mark_item", { ref: "2", status: "done" })).toMatch(/no item #2 \(no list has been shown yet\)/);
      await deps.store.state.set("lastList", { at: "2026-10-14T00:00:00.000Z", map: { "1": "gone" } });
      expect(await call("mark_item", { ref: "5", status: "done" })).toMatch(/numbered 1 to 1/);
      expect(await call("mark_item", { ref: "1", status: "done" })).toMatch(/no longer exists/);
      expect(await call("mark_item", { ref: "abc", status: "done" })).toMatch(/no item has id "abc"/);
    });
  });

  describe("snooze_item", () => {
    it("snoozes until a future SGT time", async () => {
      const a = await deps.store.items.create(makeItem({ title: "Form", dedupeKey: "a" }));
      await deps.store.state.set("lastList", { at: "2026-10-14T00:00:00.000Z", map: { "1": a.id } });
      expect(await call("snooze_item", { ref: "1", until: "2026-10-15T08:00:00+08:00" }))
        .toBe('Snoozed #1 "Form" until Thu 15 Oct, 8am.');
      expect(await deps.store.items.get(a.id)).toMatchObject({ status: "snoozed", snoozedUntil: "2026-10-15T00:00:00.000Z" });
    });

    it("rejects a past time", async () => {
      const a = await deps.store.items.create(makeItem({ dedupeKey: "a" }));
      expect(await call("snooze_item", { ref: a.id, until: "2026-10-14T07:00:00+08:00" })).toMatch(/is in the past/);
    });
  });

  describe("create_reminder", () => {
    it("stores UTC and echoes SGT", async () => {
      expect(await call("create_reminder", { text: "Submit the form", at: "2026-10-14T20:00:00+08:00" }))
        .toBe('Reminder set for Wed 14 Oct, 8pm SGT: "Submit the form".');
      const [r] = await deps.store.reminders.listPending();
      expect(r).toMatchObject({ text: "Submit the form", fireAt: "2026-10-14T12:00:00.000Z", status: "pending", itemId: null });
    });

    it("'remind me at 8pm' sent at 11pm: today's 8pm is refused so the model picks tomorrow", async () => {
      deps.clock.set("2026-10-14T23:00:00+08:00");
      const out = await call("create_reminder", { text: "Pack bag", at: "2026-10-14T20:00:00+08:00" });
      expect(out).toBe("Error: at Wed 14 Oct, 8pm is in the past (it is now Wed 14 Oct, 11pm SGT). Use the next occurrence of that time.");
      expect(await deps.store.reminders.listPending()).toHaveLength(0);
      expect(await call("create_reminder", { text: "Pack bag", at: "2026-10-15T20:00:00+08:00" }))
        .toBe('Reminder set for Thu 15 Oct, 8pm SGT: "Pack bag".');
    });

    it("reads an offset-less time as SGT, not server UTC", async () => {
      await call("create_reminder", { text: "x", at: "2026-10-14T20:00:00" });
      expect((await deps.store.reminders.listPending())[0]?.fireAt).toBe("2026-10-14T12:00:00.000Z");
    });

    it("rejects garbage times", async () => {
      expect(await call("create_reminder", { text: "x", at: "8pm" })).toMatch(/^Error: at "8pm" is not a valid time/);
    });
  });

  describe("add_task", () => {
    it("adds a manual item and does not duplicate on a repeated call", async () => {
      const first = await call("add_task", { title: "Buy graph paper", dueAt: "2026-10-17T18:00:00+08:00" });
      expect(first).toMatch(/^Added "Buy graph paper" \(due Sat 17 Oct, 6pm\)\. id=/);
      expect(await call("add_task", { title: "Buy graph paper", dueAt: "2026-10-17T18:00:00+08:00" })).toMatch(/already on the list/);
      const items = await deps.store.items.list({});
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ type: "task", status: "open", dueAt: "2026-10-17T10:00:00.000Z", source: { kind: "manual" } });
    });
  });

  describe("get_status", () => {
    it("reports accounts, Classroom, briefs, window and reminders", async () => {
      await deps.store.accounts.upsert({ id: "personal", email: "me@gmail.com", historyId: "1", watchExpiresAt: null,
        lastSyncAt: "2026-10-13T23:55:00.000Z", authStatus: "ok" });
      await deps.store.accounts.upsert({ id: "school", email: "me@students.school.edu.sg", historyId: "1", watchExpiresAt: null,
        lastSyncAt: "2026-10-13T06:05:00.000Z", authStatus: "revoked" });
      await deps.store.state.set("briefs", { lastMorningDate: "2026-10-13", lastEveningDate: "2026-10-13" });
      await deps.store.state.set("whatsapp", { lastInboundAt: "2026-10-13T23:59:00.000Z" });
      await deps.store.reminders.create({ text: "Pack bag", fireAt: "2026-10-14T12:00:00.000Z", status: "pending", itemId: null, createdAt: "x" });
      const out = await call("get_status", {});
      expect(out).toContain("personal (me@gmail.com): ok · last synced Wed 14 Oct, 7:55am");
      expect(out).toContain("school (me@students.school.edu.sg): REVOKED, reconnect with: npm run auth -- school");
      expect(out).toContain("Classroom: never synced");
      expect(out).toContain("Morning brief last sent: 2026-10-13");
      expect(out).toContain("WhatsApp window: open");
      expect(out).toContain('Pending reminders: 1 (next Wed 14 Oct, 8pm: "Pack bag")');
    });

    it("says when the window is closed and nothing is connected", async () => {
      await deps.store.state.set("whatsapp", { lastInboundAt: "2026-10-12T00:00:00.000Z" });
      const out = await call("get_status", {});
      expect(out).toContain("personal: not connected yet");
      expect(out).toContain("WhatsApp window: closed");
      expect(out).toContain("Pending reminders: 0");
    });
  });
});
