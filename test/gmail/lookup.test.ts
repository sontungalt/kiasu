import { describe, it, expect } from "vitest";
import { searchEmails, readEmail } from "../../src/gmail/lookup.js";
import type { GmailCtx } from "../../src/gmail/account.js";
import type { AccountId, EmailRecord } from "../../src/types.js";
import { makeTestDeps } from "../helpers/deps.js";
import { FakeGmailApi, buildMessage, httpError } from "../helpers/fake-gmail.js";

function setup() {
  const deps = makeTestDeps();
  const school = new FakeGmailApi("me@students.school.edu.sg");
  const personal = new FakeGmailApi("me@gmail.com");
  school.addMessage(buildMessage({ id: "s1", subject: "School older", receivedAt: "2026-10-13T01:00:00Z" }));
  school.addMessage(buildMessage({ id: "s2", subject: "School newest", receivedAt: "2026-10-13T05:00:00Z" }));
  personal.addMessage(buildMessage({ id: "p1", subject: "Personal middle", text: "Dinner at 7", receivedAt: "2026-10-13T03:00:00Z" }));
  const apis: Record<AccountId, FakeGmailApi | null> = { school, personal };
  const ctx: GmailCtx = {
    config: deps.config, clock: deps.clock, log: deps.log, store: deps.store, outbox: deps.outbox,
    gmail: (a) => apis[a],
  };
  return { deps, ctx, school, personal, apis };
}

const record = (id: string, account: AccountId): EmailRecord => ({
  id, account, threadId: `t-${id}`, from: "x", subject: "s", receivedAt: "2026-10-13T03:00:00.000Z",
  summary: null, category: null, importance: null, needsReply: false, triageStatus: "done", triageAttempts: 1, processedAt: null,
});

describe("searchEmails", () => {
  it("searches both accounts, merges newest first and respects the limit", async () => {
    const { ctx, school } = setup();
    const hits = await searchEmails(ctx, "consent", { limit: 2 });
    expect(hits.map((h) => h.id)).toEqual(["s2", "p1"]);
    expect(hits[0]).toMatchObject({ account: "school", subject: "School newest", date: "2026-10-13T05:00:00.000Z" });
    expect(school.calls).toContain("listMessages:consent");
    expect(school.calls).toContain("getMessage:s2:metadata");
  });

  it("searches one account when asked", async () => {
    const { ctx, school } = setup();
    expect((await searchEmails(ctx, "dinner", { account: "personal" })).map((h) => h.id)).toEqual(["p1"]);
    expect(school.calls).toEqual([]);
  });

  it("skips an account without a token and survives an erroring account", async () => {
    const { ctx, school, apis } = setup();
    school.failListMessages = httpError(500);
    expect((await searchEmails(ctx, "x")).map((h) => h.id)).toEqual(["p1"]);
    apis.personal = null;
    expect(await searchEmails(ctx, "x")).toEqual([]);
  });
});

describe("readEmail", () => {
  it("reads from the stored account only", async () => {
    const { deps, ctx, school } = setup();
    await deps.store.emails.upsert(record("p1", "personal"));
    const p = await readEmail(ctx, "p1");
    expect(p).toMatchObject({ id: "p1", account: "personal", text: "Dinner at 7" });
    expect(school.calls).toEqual([]);
  });

  it("tries both accounts for an unknown id and returns null when none has it", async () => {
    const { ctx } = setup();
    expect((await readEmail(ctx, "s2"))?.account).toBe("school");
    expect(await readEmail(ctx, "nope")).toBeNull();
  });
});
