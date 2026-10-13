import { describe, it, expect, vi } from "vitest";
import {
  ingestParsed, triageRecord, isClassroomSender, MAX_TRIAGE_ATTEMPTS, type ProcessCtx,
} from "../../src/gmail/process.js";
import { TriageRefusedError, type TriageFn, type TriageResult, type TriageItem } from "../../src/triage/triage.js";
import { emailDedupeKey } from "../../src/items/upsert.js";
import { FakeClock } from "../../src/lib/clock.js";
import { silentLogger } from "../../src/lib/log.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { ParsedEmail } from "../../src/types.js";

const NOW_ISO = "2026-10-14T00:05:00.000Z";

function parsedEmail(over: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    id: "m1", account: "school", threadId: "t1", from: "Mr Tan <tan@school.edu.sg>", to: "me@students.school.edu.sg",
    subject: "CCA consent form", date: "2026-10-14T00:00:00.000Z", text: "Please submit by tomorrow 3pm.",
    attachments: [], labelIds: ["INBOX"], truncated: false, ...over,
  };
}

const urgentItem: TriageItem = {
  type: "deadline", title: "Submit CCA consent form", details: null,
  dueAt: "2026-10-15T15:00:00+08:00", startAt: null, endAt: null,
  urgency: "urgent", urgencyReason: "Due tomorrow",
};

function triageResult(over: Partial<TriageResult> = {}): TriageResult {
  return {
    summary: "Mr Tan: submit the CCA consent form by Thu 3pm.", category: "school_admin",
    importance: "high", needsReply: false, items: [urgentItem], ...over,
  };
}

function setup(triage: TriageFn = async () => triageResult()) {
  const store = new MemoryStore();
  const fn = vi.fn<TriageFn>(triage);
  const ctx: ProcessCtx = { clock: new FakeClock(NOW_ISO), log: silentLogger, store, triage: fn };
  return { ctx, store, triage: fn };
}

describe("ingestParsed", () => {
  it("stores a triaged email as done and upserts its items with an email source", async () => {
    const { ctx, store } = setup();
    const r = await ingestParsed(ctx, parsedEmail());
    expect(r).toMatchObject({ fetched: 1, triaged: 1 });
    expect(await store.emails.get("m1")).toMatchObject({
      account: "school", threadId: "t1", subject: "CCA consent form", receivedAt: "2026-10-14T00:00:00.000Z",
      summary: "Mr Tan: submit the CCA consent form by Thu 3pm.", category: "school_admin", importance: "high",
      needsReply: false, triageStatus: "done", triageAttempts: 1, processedAt: NOW_ISO,
    });
    const items = await store.items.list({});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Submit CCA consent form", dueAt: "2026-10-15T07:00:00.000Z", status: "open",
      dedupeKey: emailDedupeKey("t1", "Submit CCA consent form"),
      source: { kind: "email", account: "school", emailId: "m1", threadId: "t1", from: "Mr Tan <tan@school.edu.sg>" },
    });
  });

  it("returns alert candidates but leaves alertedAt for the Notifier", async () => {
    const { ctx, store } = setup();
    const r = await ingestParsed(ctx, parsedEmail());
    expect(r.alerts).toHaveLength(1);
    expect((await store.items.get(r.alerts[0]!.id))?.alertedAt).toBeNull();
  });

  it("an ordinary undated item creates no alert", async () => {
    const { ctx, store } = setup(async () => triageResult({
      importance: "medium",
      items: [{ ...urgentItem, type: "task", dueAt: null, urgency: "normal", urgencyReason: null }],
    }));
    const r = await ingestParsed(ctx, parsedEmail());
    expect(r.alerts).toEqual([]);
    expect(await store.items.list({})).toHaveLength(1);
  });

  it.each(["SPAM", "TRASH", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"])(
    "pre-filter: %s is recorded as a skipped promotion without AI",
    async (label) => {
      const { ctx, store, triage } = setup();
      const r = await ingestParsed(ctx, parsedEmail({ labelIds: ["INBOX", label] }));
      expect(r).toEqual({ fetched: 1, triaged: 0, alerts: [] });
      expect(await store.emails.get("m1")).toMatchObject({ category: "promotion", triageStatus: "skipped", processedAt: NOW_ISO });
      expect(triage).not.toHaveBeenCalled();
      expect(await store.items.list({})).toHaveLength(0);
    },
  );

  it("Classroom notification emails are summarised but create no items", async () => {
    const { ctx, store, triage } = setup();
    const r = await ingestParsed(ctx, parsedEmail({ from: "Google Classroom <no-reply@classroom.google.com>" }));
    expect(triage).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ fetched: 1, triaged: 1, alerts: [] });
    expect(await store.emails.get("m1")).toMatchObject({ triageStatus: "done", summary: expect.any(String) });
    expect(await store.items.list({})).toHaveLength(0);
  });

  it("a follow-up in the same thread updates the item instead of duplicating it", async () => {
    const { ctx, store, triage } = setup();
    triage
      .mockResolvedValueOnce(triageResult())
      .mockResolvedValueOnce(triageResult({
        items: [{ ...urgentItem, title: "Reminder: submit CCA consent form", dueAt: "2026-10-16T15:00:00+08:00" }],
      }));
    await ingestParsed(ctx, parsedEmail());
    const second = await ingestParsed(ctx, parsedEmail({ id: "m2", subject: "Re: CCA consent form" }));
    const items = await store.items.list({});
    expect(items).toHaveLength(1);
    expect(items[0]!.dueAt).toBe("2026-10-16T07:00:00.000Z");
    expect(second.alerts.map((a) => a.id)).toEqual([items[0]!.id]);
  });
});

describe("isClassroomSender", () => {
  it("matches classroom.google.com and subdomains only", () => {
    expect(isClassroomSender("Google Classroom <no-reply@classroom.google.com>")).toBe(true);
    expect(isClassroomSender("Mr Tan (Classroom) <notifications@classroom.google.com>")).toBe(true);
    expect(isClassroomSender("x@mail.classroom.google.com")).toBe(true);
    expect(isClassroomSender("Phish <a@classroom.google.com.evil.net>")).toBe(false);
    expect(isClassroomSender("Mr Tan <tan@school.edu.sg>")).toBe(false);
  });
});

describe("triageRecord failures", () => {
  it("keeps the email pending and counts attempts, then fails at the 5th", async () => {
    const { ctx, store } = setup(async () => {
      throw new Error("overloaded");
    });
    await ingestParsed(ctx, parsedEmail());
    let rec = (await store.emails.get("m1"))!;
    expect(rec).toMatchObject({ triageStatus: "pending", triageAttempts: 1, processedAt: null });
    for (let attempt = 2; attempt <= MAX_TRIAGE_ATTEMPTS; attempt++) {
      await triageRecord(ctx, rec, parsedEmail());
      rec = (await store.emails.get("m1"))!;
      expect(rec.triageAttempts).toBe(attempt);
      expect(rec.triageStatus).toBe(attempt < MAX_TRIAGE_ATTEMPTS ? "pending" : "failed");
    }
    expect(rec.processedAt).toBe(NOW_ISO);
  });

  it("a refusal marks the email failed immediately", async () => {
    const { ctx, store } = setup(async () => {
      throw new TriageRefusedError();
    });
    await ingestParsed(ctx, parsedEmail());
    expect(await store.emails.get("m1")).toMatchObject({ triageStatus: "failed", triageAttempts: 1, processedAt: NOW_ISO });
  });
});
