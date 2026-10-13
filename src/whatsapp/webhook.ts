import type { Deps } from "../ports.js";
import type { RouteRegistrar } from "../server.js";
import {
  extractWebhook, IGNORED_TYPES, safeEqual, toInboundMessage, verifyMetaSignature, type WaRawMessage,
} from "./inbound.js";

/** Raises state.whatsapp.lastInboundAt to `atIso` (never lowers it: deliveries can arrive out of order). */
export async function bumpLastInbound(deps: Pick<Deps, "store">, atIso: string): Promise<void> {
  const cur = await deps.store.state.get("whatsapp");
  if (cur?.lastInboundAt && cur.lastInboundAt >= atIso) return;
  await deps.store.state.set("whatsapp", { ...(cur ?? {}), lastInboundAt: atIso });
}

async function processMessage(deps: Deps, m: WaRawMessage): Promise<void> {
  const now = deps.clock.now();
  if (m.from !== deps.config.MY_WHATSAPP_NUMBER) {
    deps.log.warn("whatsapp: dropped message from unknown sender", { messageId: m.id, fromSuffix: m.from.slice(-4), type: m.type });
    return;
  }
  if (!(await deps.store.processed.claim(`wa:${m.id}`, now.toISOString()))) {
    deps.log.info("whatsapp: duplicate delivery skipped", { messageId: m.id });
    return;
  }
  if (IGNORED_TYPES.has(m.type)) {
    deps.log.info("whatsapp: ignored message type", { messageId: m.id, type: m.type });
    return;
  }
  const msg = toInboundMessage(m, now);
  await bumpLastInbound(deps, msg.timestamp);
  await deps.tasks.enqueueInbound(msg);
  deps.log.info("whatsapp: message enqueued", { messageId: msg.id, type: msg.type });
}

export const registerWhatsAppRoutes: RouteRegistrar = async (app, deps) => {
  // This scope only: keep the body as raw bytes, because the signature covers the exact bytes Meta sent.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.get("/webhooks/whatsapp", async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const token = q["hub.verify_token"];
    const challenge = q["hub.challenge"];
    const expected = deps.config.WA_VERIFY_TOKEN;
    if (q["hub.mode"] === "subscribe" && typeof token === "string" && typeof challenge === "string"
      && expected && safeEqual(token, expected)) {
      return reply.code(200).type("text/plain").send(challenge);
    }
    deps.log.warn("whatsapp: verification handshake rejected");
    return reply.code(403).send({ error: "forbidden" });
  });

  app.post("/webhooks/whatsapp", async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const appSecret = deps.config.WA_APP_SECRET;
    if (!appSecret || !verifyMetaSignature(raw, request.headers["x-hub-signature-256"], appSecret)) {
      deps.log.warn("whatsapp: bad webhook signature");
      return reply.code(401).send({ error: "bad signature" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      deps.log.warn("whatsapp: signed webhook body is not JSON");
      return reply.code(200).send({ ok: true });
    }

    const { messages, statuses } = extractWebhook(payload);
    for (const s of statuses) {
      if (s.status === "failed") {
        deps.log.warn("whatsapp: outbound message failed", { messageId: s.id, codes: (s.errors ?? []).map((e) => e.code) });
      }
    }
    // Sequential, so messages in one batch are enqueued in the order Meta sent them.
    for (const m of messages) {
      try {
        await processMessage(deps, m);
      } catch (err) {
        deps.log.error("whatsapp: failed to process inbound message", { messageId: m.id, err });
      }
    }
    // Always 200 once the signature is valid: Meta retries anything else for up to 7 days.
    return reply.code(200).send({ ok: true });
  });
};
