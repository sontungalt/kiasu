import { describe, it, expect, vi } from "vitest";
import { createMailService, RESYNC_QUERY } from "../../src/gmail/sync.js";
import type { TriageFn, TriageResult } from "../../src/triage/triage.js";
import type { Outbox } from "../../src/ports.js";
import type { AccountId, AccountState, ParsedEmail } from "../../src/types.js";
import { makeTestDeps } from "../helpers/deps.js";
import { FakeGmailApi, buildMessage, httpError } from "../helpers/fake-gmail.js";

const EMPTY = { fetched: 0, triaged: 0, alerts: [] };

const triageFor: TriageFn = async (p: ParsedEmail): Promise<TriageResult> => ({
  summary: `Summary of ${p.subject}`,
  category: "school_admin",
  importance: "high",
  needsReply: false,
  items: [{
    type: "deadline", title: p.subject, details: null, dueAt: "2026-10-15T15:00:00+08:00",
    startAt: null, endAt: null, urgency: "urgent", urgencyReason: "Due tomorrow",
  }],
});

function account(id: AccountId, over: Partial<AccountState> = {}): AccountState {
  return {
    id, email: id === "school" ? "me@students.school.edu.sg" : "me@gmail.com", historyId: "100",
    watchExpiresAt: null, lastSyncAt: null, authStatus: "ok", ...over,
  };
}

async function setup(opts: { triage?: TriageFn; maxPerSync?: number; seed?: boolean } = {}) {
  const deliver = vi.fn<Outbox["deliver"]>(async () => "sent");
  const deps = makeTestDeps({ outbox: { deliver, flush: vi.fn<Outbox["flush"]>(async () => 0) } });
  const school = new FakeGmailApi("me@students.school.edu.sg");
  const personal = new FakeGmailApi("me@gmail.com");
  const apis: Record<AccountId, FakeGmailApi | null> = { school, personal };
  const triage = vi.fn<TriageFn>(opts.triage ?? triageFor);
  if (opts.seed !== false) {
    await deps.store.accounts.upsert(account("school"));
    await deps.store.accounts.upsert(account("personal"));
  }
  const mail = createMailService(deps, (a) => apis[a], { triage, maxPerSync: opts.maxPerSync });
  return { deps, school, personal, apis, triage, deliver, mail };
}

describe("syncAccount", () => {
  it("triages new inbox mail, upserts items and returns alerts without marking them alerted", async () => {
    const { deps, school, mail } = await setup();
    school.addMessage(buildMessage({ id: "m1", subject: "Submit CCA consent form" }));
    const r = await mail.syncAccount("school");
    expect(r.fetched).toBe(1);
    expect(r.triaged).toBe(1);
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({ title: "Submit CCA consent form", alertedAt: null });
    expect(await deps.store.emails.get("m1")).toMatchObject({ triageStatus: "done", summary: "Summary of Submit CCA consent form" });
    expect(await deps.store.accounts.get("school")).toMatchObject({ historyId: "101", lastSyncAt: "2026-10-14T00:00:00.000Z", authStatus: "ok" });
    expect(school.calls).toContain("listHistory:100");
  });

  it("a duplicate push does not re-triage", async () => {
    const { deps, school, triage, mail } = await setup();
    school.addMessage(buildMessage({ id: "m1" }));
    await mail.syncAccount("school");
    await deps.store.accounts.upsert(account("school")); // historyId back to 100, as if a stale push raced us
    deps.clock.advance(60_000);
    expect(await mail.syncAccount("school")).toEqual(EMPTY);
    expect(triage).toHaveBeenCalledTimes(1);
    expect(await deps.store.items.list({})).toHaveLength(1);
    // plan 04's health line: lastSyncAt moves on every successful sync, even with no new mail
    expect((await deps.store.accounts.get("school"))?.lastSyncAt).toBe("2026-10-14T00:01:00.000Z");
  });

  it("concurrent syncs triage each message once", async () => {
    const { school, triage, mail } = await setup();
    school.addMessage(buildMessage({ id: "m1" }));
    school.addMessage(buildMessage({ id: "m2" }));
    await Promise.all([mail.syncAccount("school"), mail.syncAccount("school")]);
    expect(triage).toHaveBeenCalledTimes(2);
  });

  it("historyId 404 falls back to the last 3 days, skipping seen mail", async () => {
    const { deps, school, triage, mail } = await setup();
    school.addMessage(buildMessage({ id: "m1", receivedAt: "2026-10-13T20:00:00Z" }));
    await mail.syncAccount("school");
    school.staleHistory = true;
    school.addMessage(buildMessage({ id: "m2", receivedAt: "2026-10-13T22:00:00Z" }));
    const r = await mail.syncAccount("school");
    expect(RESYNC_QUERY).toBe("in:inbox newer_than:3d");
    expect(school.calls).toContain(`listMessages:${RESYNC_QUERY}`);
    expect(r.triaged).toBe(1);
    expect(triage.mock.calls.map((c) => c[0].id)).toEqual(["m1", "m2"]);
    expect((await deps.store.accounts.get("school"))?.historyId).toBe("102");
  });

  it("first sync without a historyId bootstraps from the last 3 days, oldest first", async () => {
    const { deps, school, triage, mail } = await setup({ seed: false });
    school.addMessage(buildMessage({ id: "old", receivedAt: "2026-10-12T01:00:00Z" }));
    school.addMessage(buildMessage({ id: "new", receivedAt: "2026-10-13T01:00:00Z" }));
    await mail.syncAccount("school");
    expect(school.calls.slice(0, 2)).toEqual(["getProfile", `listMessages:${RESYNC_QUERY}`]);
    expect(triage.mock.calls.map((c) => c[0].id)).toEqual(["old", "new"]);
    expect((await deps.store.accounts.get("school"))?.historyId).toBe("102");
  });

  it("a missing refresh token gives an empty result", async () => {
    const { deps, apis, mail } = await setup();
    apis.school = null;
    expect(await mail.syncAccount("school")).toEqual(EMPTY);
    expect(await deps.store.accounts.get("school")).toMatchObject({ historyId: "100", lastSyncAt: null });
  });

  it("invalid_grant marks revoked, notifies once, and recovers", async () => {
    const { deps, school, personal, deliver, mail } = await setup();
    school.revoked = true;
    expect(await mail.syncAccount("school")).toEqual(EMPTY);
    await mail.syncAccount("school");
    expect((await deps.store.accounts.get("school"))?.authStatus).toBe("revoked");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0]).toMatchObject({
      kind: "system", template: { name: "heads_up", params: ["Reconnect your school Google account"] },
    });
    expect(deliver.mock.calls[0]![0].text).toContain("npm run auth -- school");

    personal.addMessage(buildMessage({ id: "p1" }));
    expect((await mail.syncAccount("personal")).triaged).toBe(1); // the other account keeps working

    school.revoked = false;
    await mail.syncAccount("school");
    expect((await deps.store.accounts.get("school"))?.authStatus).toBe("ok");
  });

  it("token revoked mid-sync keeps earlier results and historyId", async () => {
    const { deps, school, triage, mail } = await setup();
    school.addMessage(buildMessage({ id: "m1", subject: "First" }));
    school.addMessage(buildMessage({ id: "m2", subject: "Second" }));
    school.getsBeforeRevoke = 1;
    const r = await mail.syncAccount("school");
    expect(r.alerts.map((a) => a.title)).toEqual(["First"]);
    expect(await deps.store.accounts.get("school")).toMatchObject({ authStatus: "revoked", historyId: "100" });

    school.revoked = false;
    school.getsBeforeRevoke = null;
    const r2 = await mail.syncAccount("school");
    expect(r2.alerts.map((a) => a.title)).toEqual(["Second"]);
    expect(triage).toHaveBeenCalledTimes(2);
    expect(await deps.store.accounts.get("school")).toMatchObject({ authStatus: "ok", historyId: "102" });
  });

  it("a transient error stops the run, keeps earlier alerts and leaves historyId for next time", async () => {
    const { deps, school, mail } = await setup();
    school.addMessage(buildMessage({ id: "m1", subject: "First" }));
    school.addMessage(buildMessage({ id: "m2", subject: "Second" }));
    school.failGet.set("m2", httpError(503));
    const r = await mail.syncAccount("school");
    expect(r.alerts.map((a) => a.title)).toEqual(["First"]);
    expect((await deps.store.accounts.get("school"))?.historyId).toBe("100");
    school.failGet.clear();
    const r2 = await mail.syncAccount("school");
    expect(r2.alerts.map((a) => a.title)).toEqual(["Second"]);
    expect((await deps.store.accounts.get("school"))?.historyId).toBe("102");
  });

  it("caps work per sync and finishes on the next run", async () => {
    const { deps, school, mail } = await setup({ maxPerSync: 1 });
    school.addMessage(buildMessage({ id: "m1" }));
    school.addMessage(buildMessage({ id: "m2" }));
    expect((await mail.syncAccount("school")).triaged).toBe(1);
    expect((await deps.store.accounts.get("school"))?.historyId).toBe("100");
    expect((await mail.syncAccount("school")).triaged).toBe(1);
    expect((await deps.store.accounts.get("school"))?.historyId).toBe("102");
  });
});

describe("retryPendingTriage", () => {
  it("retries until the 5th attempt, then marks failed and stops", async () => {
    const { deps, school, triage, mail } = await setup({
      triage: async () => {
        throw new Error("overloaded");
      },
    });
    school.addMessage(buildMessage({ id: "m1" }));
    await mail.syncAccount("school");
    for (let i = 0; i < 4; i++) await mail.retryPendingTriage();
    expect(await deps.store.emails.get("m1")).toMatchObject({
      triageStatus: "failed", triageAttempts: 5, processedAt: "2026-10-14T00:00:00.000Z",
    });
    await mail.retryPendingTriage();
    expect(triage).toHaveBeenCalledTimes(5);
  });

  it("a successful retry stores the result and returns its alerts", async () => {
    let calls = 0;
    const flaky: TriageFn = async (p, a, n) => {
      calls++;
      if (calls === 1) throw new Error("overloaded");
      return triageFor(p, a, n);
    };
    const { deps, school, mail } = await setup({ triage: flaky });
    school.addMessage(buildMessage({ id: "m1" }));
    expect((await mail.syncAccount("school")).alerts).toEqual([]);
    const r = await mail.retryPendingTriage();
    expect(r.fetched).toBe(0);
    expect(r.triaged).toBe(1);
    expect(r.alerts).toHaveLength(1);
    expect(await deps.store.emails.get("m1")).toMatchObject({ triageStatus: "done", triageAttempts: 2 });
  });

  it("marks a pending email that no longer exists as skipped", async () => {
    const { deps, triage, mail } = await setup();
    await deps.store.emails.upsert({
      id: "gone", account: "school", threadId: "t", from: "x", subject: "s", receivedAt: "2026-10-13T00:00:00.000Z",
      summary: null, category: null, importance: null, needsReply: false, triageStatus: "pending", triageAttempts: 1, processedAt: null,
    });
    await mail.retryPendingTriage();
    expect(await deps.store.emails.get("gone")).toMatchObject({ triageStatus: "skipped" });
    expect(triage).not.toHaveBeenCalled();
  });
});

describe("handlePush and delegation", () => {
  it("maps the push address to an account, case-insensitively", async () => {
    const { school, personal, mail } = await setup();
    school.addMessage(buildMessage({ id: "m1" }));
    expect((await mail.handlePush({ emailAddress: "ME@STUDENTS.SCHOOL.EDU.SG", historyId: "999" })).triaged).toBe(1);
    expect(personal.calls).toEqual([]);
    expect(await mail.handlePush({ emailAddress: "stranger@example.com", historyId: "1" })).toEqual(EMPTY);
    expect(school.calls.filter((c) => c.startsWith("listHistory"))).toHaveLength(1);
  });

  it("renewWatchIfNeeded, search and read go through the Gmail API", async () => {
    const { deps, school, mail } = await setup({ seed: false });
    school.addMessage(buildMessage({ id: "m1", subject: "Consent form" }));
    await mail.renewWatchIfNeeded("school");
    expect(await deps.store.accounts.get("school")).toMatchObject({ email: "me@students.school.edu.sg", historyId: "101" });
    expect((await mail.search("consent", { account: "school" })).map((h) => h.id)).toEqual(["m1"]);
    expect((await mail.read("m1"))?.subject).toBe("Consent form");
  });
});
