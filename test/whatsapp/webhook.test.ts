import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { registerWhatsAppRoutes } from "../../src/whatsapp/webhook.js";
import type { TaskQueue } from "../../src/ports.js";
import type { InboundMessage } from "../../src/types.js";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import { TEST_ENV } from "../helpers/env.js";

const ME = TEST_ENV.MY_WHATSAPP_NUMBER!; // "6500000000"
const T0 = 1791936000; // 2026-10-14T00:00:00Z, the test clock's "now"

const sign = (raw: string, secret = TEST_ENV.WA_APP_SECRET!) =>
  `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

function webhookBody(messages: unknown[], statuses: unknown[] = []): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA_ID", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "15550000000", phone_number_id: "123456" },
      ...(messages.length ? { contacts: [{ profile: { name: "Me" }, wa_id: ME }], messages } : {}),
      ...(statuses.length ? { statuses } : {}),
    } }] }],
  });
}

const textMsg = (id: string, body: string, ts = T0, from = ME) =>
  ({ from, id, timestamp: String(ts), type: "text", text: { body } });

describe("WhatsApp webhook routes", () => {
  let deps: TestDeps;
  let app: FastifyInstance;
  let enqueued: InboundMessage[];
  let failNext: boolean;

  beforeEach(async () => {
    enqueued = [];
    failNext = false;
    const tasks: TaskQueue = {
      enqueueInbound: async (m) => {
        if (failNext) {
          failNext = false;
          throw new Error("queue down");
        }
        enqueued.push(m);
      },
    };
    deps = makeTestDeps({ tasks });
    app = await buildServer(deps, [registerWhatsAppRoutes]);
  });

  const post = (raw: string, signature: string | null = sign(raw)) =>
    app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: raw,
      headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
    });

  it("without WA_VERIFY_TOKEN / WA_APP_SECRET, rejects the handshake and every POST", async () => {
    const bare = makeTestDeps({ tasks: { enqueueInbound: async (m) => void enqueued.push(m) } });
    bare.config = { ...bare.config, WA_VERIFY_TOKEN: undefined, WA_APP_SECRET: undefined };
    const a = await buildServer(bare, [registerWhatsAppRoutes]);
    const get = await a.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=1" });
    expect(get.statusCode).toBe(403);
    const raw = webhookBody([textMsg("wamid.x", "hi")]);
    const res = await a.inject({
      method: "POST", url: "/webhooks/whatsapp", payload: raw,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, "") },
    });
    expect(res.statusCode).toBe(401);
    expect(enqueued).toEqual([]);
    await a.close();
  });

  describe("GET verification handshake", () => {
    it("echoes hub.challenge as text/plain when the token matches", async () => {
      const res = await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=1158201444" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/plain/);
      expect(res.body).toBe("1158201444");
    });

    it("403 on a wrong token or mode", async () => {
      expect((await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1" })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=wa-verify&hub.challenge=1" })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/webhooks/whatsapp" })).statusCode).toBe(403);
    });
  });

  describe("POST", () => {
    it("401 on a missing or wrong signature, and nothing is processed", async () => {
      const raw = webhookBody([textMsg("wamid.1", "hi")]);
      expect((await post(raw, null)).statusCode).toBe(401);
      expect((await post(raw, sign(raw, "wrong-secret"))).statusCode).toBe(401);
      expect(enqueued).toEqual([]);
      expect(await deps.store.state.get("whatsapp")).toBeNull();
    });

    it("enqueues my text message and records lastInboundAt", async () => {
      const res = await post(webhookBody([textMsg("wamid.1", "what's due this week?", T0 - 60)]));
      expect(res.statusCode).toBe(200);
      expect(enqueued).toEqual([{
        id: "wamid.1", from: ME, timestamp: "2026-10-13T23:59:00.000Z",
        type: "text", text: "what's due this week?", contextMessageId: null,
      }]);
      expect(await deps.store.state.get("whatsapp")).toEqual({ lastInboundAt: "2026-10-13T23:59:00.000Z" });
    });

    it("verifies against the raw bytes (escaped unicode body)", async () => {
      const raw = webhookBody([textMsg("wamid.U", "PLACEHOLDER")]).replace("PLACEHOLDER", "caf\\u00e9 \\ud83d\\ude00");
      expect((await post(raw)).statusCode).toBe(200);
      expect(enqueued[0]?.text).toBe("café 😀");
    });

    it("Meta delivering the same message twice enqueues it once", async () => {
      const raw = webhookBody([textMsg("wamid.dup", "done 2")]);
      expect((await post(raw)).statusCode).toBe(200);
      expect((await post(raw)).statusCode).toBe(200);
      expect(enqueued.map((m) => m.id)).toEqual(["wamid.dup"]);
    });

    it("out-of-order delivery never moves lastInboundAt backwards", async () => {
      await post(webhookBody([textMsg("wamid.new", "newer", T0)]));
      await post(webhookBody([textMsg("wamid.old", "older", T0 - 3600)]));
      expect(enqueued.map((m) => m.id)).toEqual(["wamid.new", "wamid.old"]);
      expect(await deps.store.state.get("whatsapp")).toEqual({ lastInboundAt: "2026-10-14T00:00:00.000Z" });
    });

    it("a status-only webhook is acknowledged and changes nothing", async () => {
      const res = await post(webhookBody([], [
        { id: "wamid.S", status: "delivered", timestamp: String(T0), recipient_id: ME },
        { id: "wamid.F", status: "failed", timestamp: String(T0), recipient_id: ME, errors: [{ code: 131047, title: "Re-engagement message" }] },
      ]));
      expect(res.statusCode).toBe(200);
      expect(enqueued).toEqual([]);
      expect(await deps.store.state.get("whatsapp")).toBeNull();
    });

    it("a stranger messaging the bot number is dropped: no task, no window, no claim", async () => {
      const res = await post(webhookBody([textMsg("wamid.s", "hello?", T0, "6599999999")]));
      expect(res.statusCode).toBe(200);
      expect(enqueued).toEqual([]);
      expect(await deps.store.state.get("whatsapp")).toBeNull();
      expect(await deps.store.processed.claim("wa:wamid.s", "2026-10-14T00:00:00.000Z")).toBe(true);
    });

    it("maps a template quick-reply tap to a button message with its context id", async () => {
      await post(webhookBody([{
        context: { from: "15550000000", id: "wamid.TEMPLATE" },
        from: ME, id: "wamid.tap", timestamp: String(T0), type: "button", button: { payload: "Show me", text: "Show me" },
      }]));
      expect(enqueued[0]).toMatchObject({ type: "button", text: "Show me", contextMessageId: "wamid.TEMPLATE" });
    });

    it("non-text messages are enqueued as unsupported; reactions are ignored", async () => {
      await post(webhookBody([
        { from: ME, id: "wamid.img", timestamp: String(T0 - 10), type: "image", image: { id: "media1", mime_type: "image/jpeg" } },
        { from: ME, id: "wamid.react", timestamp: String(T0), type: "reaction", reaction: { message_id: "wamid.out", emoji: "👍" } },
      ]));
      expect(enqueued.map((m) => [m.id, m.type, m.text])).toEqual([["wamid.img", "unsupported", null]]);
      expect(await deps.store.state.get("whatsapp")).toEqual({ lastInboundAt: "2026-10-13T23:59:50.000Z" });
    });

    it("one message failing to enqueue still returns 200 and the rest are processed", async () => {
      failNext = true;
      const res = await post(webhookBody([textMsg("wamid.a", "one"), textMsg("wamid.b", "two")]));
      expect(res.statusCode).toBe(200);
      expect(enqueued.map((m) => m.id)).toEqual(["wamid.b"]);
    });

    it("a correctly signed non-JSON body is acknowledged", async () => {
      expect((await post("not json")).statusCode).toBe(200);
    });

    it("does not affect JSON parsing of routes outside its scope", async () => {
      const other = await buildServer(deps, [
        registerWhatsAppRoutes,
        (a) => { a.post("/echo", async (req) => req.body); },
      ]);
      const res = await other.inject({ method: "POST", url: "/echo", payload: { a: 1 } });
      expect(res.json()).toEqual({ a: 1 });
    });
  });
});
