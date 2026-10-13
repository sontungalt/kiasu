import { z } from "zod";
import type { Deps } from "../ports.js";
import type { RouteRegistrar } from "../server.js";
import { oidcPreHandler } from "../http/oidc.js";

export const UNSUPPORTED_TEXT = "I can only read text for now 🙂";
export const SORRY_TEXT = "Sorry, something went wrong. Try again in a minute.";
const REPLY_TEMPLATE = { name: "heads_up" as const, params: ["You have a reply waiting"] };

const InboundMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string(),
  timestamp: z.string(),
  type: z.enum(["text", "button", "unsupported"]),
  text: z.string().nullable(),
  contextMessageId: z.string().nullable(),
});

const ACKS = new Set([
  "ok", "okay", "okie", "k", "kk", "ok thanks", "ok thank you", "thanks", "thank you", "thx", "ty",
  "show me", "show", "details", "detail", "yes", "yep", "yeah", "sure", "got it", "noted", "👍",
]);

/**
 * True for a short acknowledgement ("ok", "Show me", "👍") typed in reply to a template.
 * When pending messages were just flushed, the flush already answered it, so the agent is skipped.
 */
export function isWindowAck(text: string): boolean {
  const t = text.toLowerCase().replace(/[.!?,~]+/g, " ").replace(/\s+/g, " ").trim();
  return ACKS.has(t);
}

async function deliverReply(deps: Pick<Deps, "outbox">, text: string): Promise<void> {
  await deps.outbox.deliver({ kind: "reply", text, template: REPLY_TEMPLATE });
}

export const registerTaskRoutes: RouteRegistrar = (app, deps) => {
  app.post("/tasks/handle-message", { preHandler: oidcPreHandler(deps) }, async (request) => {
    const parsed = InboundMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      // Retrying a malformed task can't help, so acknowledge it (200) and log.
      deps.log.error("handle-message: invalid body", { issues: parsed.error.issues.length });
      return { ok: false };
    }
    const msg = parsed.data;
    const now = deps.clock.now();

    // Cloud Tasks delivers at least once: process each WhatsApp message id at most once.
    if (!(await deps.store.processed.claim(`task:${msg.id}`, now.toISOString()))) {
      deps.log.info("handle-message: duplicate task", { messageId: msg.id });
      return { ok: true, duplicate: true };
    }

    try {
      // The user's message opened the 24h window: send anything that was queued.
      const flushed = await deps.outbox.flush();
      if (msg.type === "button") return { ok: true, flushed };
      if (msg.type === "unsupported") {
        await deliverReply(deps, UNSUPPORTED_TEXT);
        return { ok: true, flushed };
      }
      const text = (msg.text ?? "").trim();
      if (!text) return { ok: true, flushed };
      if (flushed > 0 && isWindowAck(text)) {
        deps.log.info("handle-message: ack after flush, agent skipped", { messageId: msg.id, flushed });
        return { ok: true, flushed, skipped: true };
      }
      const answer = await deps.agent.reply(text);
      await deliverReply(deps, answer);
      return { ok: true, flushed };
    } catch (err) {
      deps.log.error("handle-message failed", { err, messageId: msg.id });
      try {
        await deliverReply(deps, SORRY_TEXT);
      } catch (sendErr) {
        deps.log.error("handle-message: could not send the error reply", { err: sendErr, messageId: msg.id });
      }
      // Still 200: a retry would be a no-op (already claimed) and could only duplicate messages.
      return { ok: false };
    }
  });
};
