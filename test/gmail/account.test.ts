import { describe, it, expect, vi } from "vitest";
import { withGmail, getAccount, reconnectMessage, type GmailCtx } from "../../src/gmail/account.js";
import type { Outbox } from "../../src/ports.js";
import { makeTestDeps } from "../helpers/deps.js";
import { FakeGmailApi, invalidGrantError, httpError } from "../helpers/fake-gmail.js";

function setup(api: FakeGmailApi | null, impl?: Outbox["deliver"]) {
  const deliver = vi.fn<Outbox["deliver"]>(impl ?? (async () => "sent"));
  const deps = makeTestDeps({ outbox: { deliver, flush: vi.fn<Outbox["flush"]>(async () => 0) } });
  const ctx: GmailCtx = {
    config: deps.config, clock: deps.clock, log: deps.log, store: deps.store, outbox: deps.outbox,
    gmail: () => api,
  };
  return { deps, ctx, deliver };
}
const boom = async (): Promise<never> => {
  throw invalidGrantError();
};

describe("withGmail", () => {
  it("returns no_token without calling fn when the account has no refresh token", async () => {
    const { ctx } = setup(null);
    const fn = vi.fn(async () => 1);
    expect(await withGmail(ctx, "school", fn)).toEqual({ ok: false, reason: "no_token" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("invalid_grant marks the account revoked and sends one reconnect notice", async () => {
    const { ctx, deps, deliver } = setup(new FakeGmailApi());
    expect(await withGmail(ctx, "school", boom)).toEqual({ ok: false, reason: "revoked" });
    expect(await withGmail(ctx, "school", boom)).toEqual({ ok: false, reason: "revoked" });
    expect((await getAccount(deps.store, "school")).authStatus).toBe("revoked");
    expect(deliver).toHaveBeenCalledTimes(1);
    const msg = deliver.mock.calls[0]![0];
    expect(msg).toEqual(reconnectMessage("school"));
    expect(msg).toMatchObject({ kind: "system", template: { name: "heads_up", params: ["Reconnect your school Google account"] } });
    expect(msg.text).toContain("npm run auth -- school");
  });

  it("a later success flips revoked back to ok without touching other fields", async () => {
    const { ctx, deps } = setup(new FakeGmailApi());
    await deps.store.accounts.upsert({
      id: "school", email: "me@students.school.edu.sg", historyId: "5", watchExpiresAt: null, lastSyncAt: null, authStatus: "revoked",
    });
    expect(await withGmail(ctx, "school", async () => 42)).toEqual({ ok: true, value: 42 });
    expect(await deps.store.accounts.get("school")).toMatchObject({ authStatus: "ok", historyId: "5" });
  });

  it("rethrows other errors and leaves authStatus alone", async () => {
    const { ctx, deps, deliver } = setup(new FakeGmailApi());
    await expect(withGmail(ctx, "school", async () => {
      throw httpError(503);
    })).rejects.toMatchObject({ status: 503 });
    expect(await deps.store.accounts.get("school")).toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("a failing outbox does not hide the revoked state", async () => {
    const { ctx, deps } = setup(new FakeGmailApi(), async () => {
      throw new Error("whatsapp down");
    });
    expect(await withGmail(ctx, "personal", boom)).toEqual({ ok: false, reason: "revoked" });
    expect((await getAccount(deps.store, "personal")).authStatus).toBe("revoked");
  });
});
