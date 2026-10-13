import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { buildApp, buildDeps, chooseStoreKind, chooseTaskQueueKind, registrarsFor, type BuildOptions } from "../src/app.js";
import { registerGmailRoutes } from "../src/gmail/routes.js";
import { registerJobRoutes } from "../src/scheduler/routes.js";
import { registerTaskRoutes } from "../src/agent/routes.js";
import { registerWhatsAppRoutes } from "../src/whatsapp/webhook.js";
import { registerTelegramRoutes } from "../src/telegram/webhook.js";
import { loadConfig } from "../src/config.js";
import { FakeClock } from "../src/lib/clock.js";
import { silentLogger } from "../src/lib/log.js";
import { MemoryStore } from "../src/store/memory.js";
import type { ChatAgent, WhatsAppClient } from "../src/ports.js";
import type { InboundMessage } from "../src/types.js";
import { TEST_ENV } from "./helpers/env.js";

// No test may reach the network: Graph API, Google and Anthropic all go through this.
const fakeFetch = vi.fn(async () =>
  new Response(JSON.stringify({ messages: [{ id: "wamid.fake" }] }), { status: 200, headers: { "content-type": "application/json" } }));

async function build(env: Record<string, string> = {}, overrides: BuildOptions["overrides"] = {}) {
  const config = loadConfig({ ...TEST_ENV, ...env });
  return buildApp(config, {
    env: { STORE: "memory" },
    overrides: {
      clock: new FakeClock("2026-10-14T00:00:00Z"),
      log: silentLogger,
      anthropic: new Anthropic({ apiKey: "test-key", maxRetries: 0, fetch: fakeFetch as unknown as typeof fetch }),
      ...overrides,
    },
  });
}

beforeEach(() => {
  fakeFetch.mockClear();
  vi.stubGlobal("fetch", fakeFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("composition root", () => {
  it("registers every route from spec §4", async () => {
    const { app } = await build();
    for (const [method, url] of [
      ["GET", "/healthz"],
      ["GET", "/webhooks/whatsapp"],
      ["POST", "/webhooks/whatsapp"],
      ["POST", "/webhooks/gmail"],
      ["POST", "/jobs/tick"],
      ["POST", "/tasks/handle-message"],
    ] as const) {
      expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }
    expect((await app.inject("/healthz")).json()).toEqual({ ok: true });
    await app.close();
  });

  it("Google-called routes reject requests without OIDC", async () => {
    const { app } = await build();
    for (const url of ["/webhooks/gmail", "/jobs/tick", "/tasks/handle-message"]) {
      const res = await app.inject({ method: "POST", url, payload: {} });
      expect(res.statusCode, url).toBe(401);
    }
    await app.close();
  });

  it("WhatsApp: verification handshake echoes the challenge; bad signatures are rejected", async () => {
    const { app } = await build();
    const ok = await app.inject({
      method: "GET",
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TEST_ENV.WA_VERIFY_TOKEN}&hub.challenge=4242`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("4242");
    const wrong = await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1" });
    expect(wrong.statusCode).not.toBe(200);
    const forged = await app.inject({
      method: "POST", url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
      payload: { object: "whatsapp_business_account", entry: [] },
    });
    expect([401, 403]).toContain(forged.statusCode);
    await app.close();
  });

  it("uses MemoryStore when STORE=memory", async () => {
    const { app, deps } = await build();
    expect(deps.store).toBeInstanceOf(MemoryStore);
    await app.close();
  });

  it("with DEV_SKIP_OIDC the inline task queue runs /tasks/handle-message (same path as Cloud Tasks)", async () => {
    const agent: ChatAgent = { reply: vi.fn(async () => "pong") };
    const whatsapp: WhatsAppClient = {
      sendText: vi.fn(async () => ({ messageId: "w1" })),
      sendTemplate: vi.fn(async () => ({ messageId: "w2" })),
    };
    const { app, deps } = await build({ DEV_SKIP_OIDC: "true" }, { agent, whatsapp });
    const msg: InboundMessage = {
      id: "wamid.inline1", from: TEST_ENV.MY_WHATSAPP_NUMBER!, timestamp: "2026-10-14T00:00:00.000Z",
      type: "text", text: "ping", contextMessageId: null,
    };
    await deps.tasks.enqueueInbound(msg);
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledWith("ping"));
    await app.close();
  });
});

describe("free hosting wiring", () => {
  const JOB_SECRET = "j".repeat(40);
  const TG_SECRET = "tg_secret-0123456789abcdef";
  const TELEGRAM = {
    MESSENGER: "telegram", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "4242", TELEGRAM_WEBHOOK_SECRET: TG_SECRET,
    TASKS_QUEUE: "", JOB_SECRET,
  };

  it("registrarsFor: Gmail, jobs and tasks always, then the selected messenger's routes", () => {
    const wa = registrarsFor(loadConfig(TEST_ENV));
    const tg = registrarsFor(loadConfig({ ...TEST_ENV, ...TELEGRAM }));
    expect(wa.slice(0, 3)).toEqual([registerGmailRoutes, registerJobRoutes, registerTaskRoutes]);
    expect(tg.slice(0, 3)).toEqual([registerGmailRoutes, registerJobRoutes, registerTaskRoutes]);
    expect(wa.slice(3)).toEqual([registerWhatsAppRoutes]);
    expect(tg.slice(3)).toEqual([registerTelegramRoutes]);
  });

  it("MESSENGER=telegram: /webhooks/telegram instead of WhatsApp; jobs still need auth", async () => {
    const { app } = await build(TELEGRAM);
    expect(app.hasRoute({ method: "POST", url: "/webhooks/telegram" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/webhooks/whatsapp" })).toBe(false);
    expect(app.hasRoute({ method: "GET", url: "/webhooks/whatsapp" })).toBe(false);
    expect((await app.inject({ method: "POST", url: "/jobs/tick" })).statusCode).toBe(401);
    await app.close();
  });

  it("MESSENGER=telegram end to end: webhook → in-process queue → agent → reply via the Bot API, no window needed", async () => {
    const agent: ChatAgent = { reply: vi.fn(async () => "*3 things* due this week") };
    const tgFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 }));
    vi.stubGlobal("fetch", tgFetch);
    const { app } = await build(TELEGRAM, { agent });
    const res = await app.inject({
      method: "POST", url: "/webhooks/telegram",
      headers: { "x-telegram-bot-api-secret-token": TG_SECRET },
      payload: { update_id: 1, message: { message_id: 5, date: 1791936000, chat: { id: 4242, type: "private" }, text: "what's due this week?" } },
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(tgFetch).toHaveBeenCalled());
    expect(agent.reply).toHaveBeenCalledWith("what's due this week?");
    const [url, init] = tgFetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(JSON.parse(String(init!.body))).toMatchObject({ chat_id: 4242, text: "*3 things* due this week", parse_mode: "Markdown" });
    await app.close();
  });

  it("without TASKS_QUEUE the in-process queue calls /tasks/handle-message with JOB_SECRET", async () => {
    const agent: ChatAgent = { reply: vi.fn(async () => "pong") };
    const whatsapp: WhatsAppClient = {
      sendText: vi.fn(async () => ({ messageId: "w1" })),
      sendTemplate: vi.fn(async () => ({ messageId: "w2" })),
    };
    const { app, deps } = await build({ TASKS_QUEUE: "", JOB_SECRET }, { agent, whatsapp });
    await deps.tasks.enqueueInbound({
      id: "tg:1", from: "1", timestamp: "2026-10-14T00:00:00.000Z", type: "text", text: "ping", contextMessageId: null,
    });
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledWith("ping"));
    await app.close();
  });

  it("chooseTaskQueueKind: inline with DEV_SKIP_OIDC or without TASKS_QUEUE, otherwise Cloud Tasks", () => {
    expect(chooseTaskQueueKind({ DEV_SKIP_OIDC: true, TASKS_QUEUE: "q" })).toBe("inline");
    expect(chooseTaskQueueKind({ DEV_SKIP_OIDC: false, TASKS_QUEUE: undefined })).toBe("inline");
    expect(chooseTaskQueueKind({ DEV_SKIP_OIDC: false, TASKS_QUEUE: "q" })).toBe("cloud");
  });

  it("passes FIRESTORE_CREDENTIALS_JSON to Firestore", () => {
    const config = loadConfig({ ...TEST_ENV, FIRESTORE_CREDENTIALS_JSON: "not json" });
    expect(() => buildDeps(config, { env: { STORE: "firestore" }, overrides: { log: silentLogger } }))
      .toThrow(/FIRESTORE_CREDENTIALS_JSON is not valid JSON/);
  });
});

describe("chooseStoreKind", () => {
  it("defaults to firestore, allows memory outside production, rejects nonsense", () => {
    expect(chooseStoreKind({ NODE_ENV: "development" }, {})).toBe("firestore");
    expect(chooseStoreKind({ NODE_ENV: "development" }, { STORE: "firestore" })).toBe("firestore");
    expect(chooseStoreKind({ NODE_ENV: "development" }, { STORE: "memory" })).toBe("memory");
    expect(() => chooseStoreKind({ NODE_ENV: "production" }, { STORE: "memory" })).toThrow(/not allowed in production/);
    expect(() => chooseStoreKind({ NODE_ENV: "development" }, { STORE: "redis" })).toThrow(/STORE must be/);
  });
});
