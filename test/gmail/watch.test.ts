import { describe, it, expect } from "vitest";
import { renewWatch } from "../../src/gmail/watch.js";
import type { GmailCtx } from "../../src/gmail/account.js";
import { makeTestDeps } from "../helpers/deps.js";
import { FakeGmailApi } from "../helpers/fake-gmail.js";

function setup(api: FakeGmailApi | null) {
  const deps = makeTestDeps(); // clock: 2026-10-14T00:00:00Z
  const ctx: GmailCtx = {
    config: deps.config, clock: deps.clock, log: deps.log, store: deps.store, outbox: deps.outbox,
    gmail: () => api,
  };
  return { deps, ctx };
}

describe("renewWatch", () => {
  it("bootstraps a new account: email, historyId and expiry", async () => {
    const api = new FakeGmailApi("Me@Students.school.edu.sg");
    const { deps, ctx } = setup(api);
    await renewWatch(ctx, "school");
    expect(api.calls).toEqual(["getProfile", `watch:${deps.config.GMAIL_PUBSUB_TOPIC}`]);
    expect(await deps.store.accounts.get("school")).toEqual({
      id: "school", email: "me@students.school.edu.sg", historyId: "100",
      watchExpiresAt: "2026-10-21T00:00:00.000Z", lastSyncAt: null, authStatus: "ok",
    });
  });

  it("does nothing while the watch has more than 48h left", async () => {
    const api = new FakeGmailApi();
    const { deps, ctx } = setup(api);
    await deps.store.accounts.upsert({
      id: "school", email: "me@students.school.edu.sg", historyId: "50",
      watchExpiresAt: "2026-10-16T00:01:00.000Z", lastSyncAt: null, authStatus: "ok",
    });
    await renewWatch(ctx, "school");
    expect(api.calls).toEqual([]);
  });

  it("renews inside 48h and keeps the stored historyId", async () => {
    const api = new FakeGmailApi();
    const { deps, ctx } = setup(api);
    await deps.store.accounts.upsert({
      id: "school", email: "me@students.school.edu.sg", historyId: "50",
      watchExpiresAt: "2026-10-15T23:59:00.000Z", lastSyncAt: null, authStatus: "ok",
    });
    await renewWatch(ctx, "school");
    expect(api.calls).toEqual([`watch:${deps.config.GMAIL_PUBSUB_TOPIC}`]);
    expect(await deps.store.accounts.get("school")).toMatchObject({ historyId: "50", watchExpiresAt: "2026-10-21T00:00:00.000Z" });
  });

  describe("without GMAIL_PUBSUB_TOPIC (polling only)", () => {
    function pollingSetup(api: FakeGmailApi) {
      const s = setup(api);
      s.ctx.config = { ...s.ctx.config, GMAIL_PUBSUB_TOPIC: undefined };
      return s;
    }

    it("never calls users.watch; bootstraps only the email and leaves historyId for syncAccount", async () => {
      const api = new FakeGmailApi("Me@Students.school.edu.sg");
      const { deps, ctx } = pollingSetup(api);
      await renewWatch(ctx, "school");
      expect(api.calls).toEqual(["getProfile"]);
      expect(await deps.store.accounts.get("school")).toEqual({
        id: "school", email: "me@students.school.edu.sg", historyId: null,
        watchExpiresAt: null, lastSyncAt: null, authStatus: "ok",
      });
    });

    it("does nothing once the email is known, even with no watch recorded", async () => {
      const api = new FakeGmailApi();
      const { deps, ctx } = pollingSetup(api);
      await deps.store.accounts.upsert({
        id: "school", email: "me@students.school.edu.sg", historyId: "50",
        watchExpiresAt: null, lastSyncAt: null, authStatus: "ok",
      });
      await renewWatch(ctx, "school");
      expect(api.calls).toEqual([]);
      expect(await deps.store.accounts.get("school")).toMatchObject({ historyId: "50", watchExpiresAt: null });
    });
  });

  it("is a no-op without a refresh token", async () => {
    const { deps, ctx } = setup(null);
    await renewWatch(ctx, "school");
    expect(await deps.store.accounts.get("school")).toBeNull();
  });
});
