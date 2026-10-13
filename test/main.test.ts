import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { buildApp, chooseStoreKind, type BuildOptions } from "../src/app.js";
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

describe("chooseStoreKind", () => {
  it("defaults to firestore, allows memory outside production, rejects nonsense", () => {
    expect(chooseStoreKind({ NODE_ENV: "development" }, {})).toBe("firestore");
    expect(chooseStoreKind({ NODE_ENV: "development" }, { STORE: "firestore" })).toBe("firestore");
    expect(chooseStoreKind({ NODE_ENV: "development" }, { STORE: "memory" })).toBe("memory");
    expect(() => chooseStoreKind({ NODE_ENV: "production" }, { STORE: "memory" })).toThrow(/not allowed in production/);
    expect(() => chooseStoreKind({ NODE_ENV: "development" }, { STORE: "redis" })).toThrow(/STORE must be/);
  });
});
