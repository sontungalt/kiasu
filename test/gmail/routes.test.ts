import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import { registerGmailRoutes } from "../../src/gmail/routes.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/log.js";
import type { MailService, Notifier, SyncResult } from "../../src/ports.js";
import type { Item } from "../../src/types.js";
import { makeTestDeps } from "../helpers/deps.js";
import { TEST_ENV } from "../helpers/env.js";
import { makeItem } from "../store/contract.js";

const ALERT: Item = { ...makeItem({ urgency: "urgent" }), id: "i1" };

function envelope(messageId: string, data: unknown = { emailAddress: "me@students.school.edu.sg", historyId: 12345 }) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(data)).toString("base64"),
      messageId,
      message_id: messageId,
      publishTime: "2026-10-14T00:00:00.000Z",
    },
    subscription: "projects/demo-inbox/subscriptions/gmail-push",
  };
}

async function setup(opts: { skipOidc?: boolean; handlePush?: MailService["handlePush"] } = {}) {
  const lines: string[] = [];
  const handlePush = vi.fn<MailService["handlePush"]>(
    opts.handlePush ?? (async (): Promise<SyncResult> => ({ fetched: 1, triaged: 1, alerts: [ALERT] })),
  );
  const sendAlerts = vi.fn<Notifier["sendAlerts"]>(async () => {});
  const deps = makeTestDeps({
    config: loadConfig({ ...TEST_ENV, DEV_SKIP_OIDC: opts.skipOidc === false ? "false" : "true" }),
    log: createLogger({}, (l) => lines.push(l)),
    mail: { handlePush } as unknown as MailService,
    notifier: { sendAlerts },
  });
  const app = await buildServer(deps, [registerGmailRoutes]);
  const push = (payload: unknown) => app.inject({ method: "POST", url: "/webhooks/gmail", payload: payload as object });
  return { app, push, handlePush, sendAlerts, lines };
}

describe("POST /webhooks/gmail", () => {
  it("acks with 204, syncs the account and forwards alerts", async () => {
    const { push, handlePush, sendAlerts } = await setup();
    const res = await push(envelope("ps-1"));
    expect(res.statusCode).toBe(204);
    expect(handlePush).toHaveBeenCalledWith({ emailAddress: "me@students.school.edu.sg", historyId: "12345" });
    expect(sendAlerts).toHaveBeenCalledWith([ALERT]);
  });

  it("a redelivered Pub/Sub message is processed once", async () => {
    const { push, handlePush } = await setup();
    expect((await push(envelope("ps-2"))).statusCode).toBe(204);
    expect((await push(envelope("ps-2"))).statusCode).toBe(204);
    expect(handlePush).toHaveBeenCalledTimes(1);
  });

  it("does not call the notifier when there are no alerts", async () => {
    const { push, sendAlerts } = await setup({ handlePush: async () => ({ fetched: 0, triaged: 0, alerts: [] }) });
    await push(envelope("ps-3"));
    expect(sendAlerts).not.toHaveBeenCalled();
  });

  it("a sync failure is logged and still acked with 204", async () => {
    const { push, sendAlerts, lines } = await setup({
      handlePush: async () => {
        throw new Error("gmail down");
      },
    });
    expect((await push(envelope("ps-4"))).statusCode).toBe(204);
    expect(lines.some((l) => l.includes("gmail push failed"))).toBe(true);
    expect(sendAlerts).not.toHaveBeenCalled();
  });

  it("malformed envelopes and payloads are acked and ignored", async () => {
    const { push, handlePush } = await setup();
    expect((await push({ foo: 1 })).statusCode).toBe(204);
    expect((await push({ message: { data: Buffer.from("nope").toString("base64"), messageId: "ps-5" } })).statusCode).toBe(204);
    expect((await push(envelope("ps-6", { historyId: 1 }))).statusCode).toBe(204);
    expect(handlePush).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated pushes when OIDC is on", async () => {
    const { push, handlePush } = await setup({ skipOidc: false });
    expect((await push(envelope("ps-7"))).statusCode).toBe(401);
    expect(handlePush).not.toHaveBeenCalled();
  });
});
