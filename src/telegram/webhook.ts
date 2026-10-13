import type { Deps } from "../ports.js";
import type { RouteRegistrar } from "../server.js";
import type { InboundMessage } from "../types.js";
import { safeEqual, unixToIso } from "../whatsapp/inbound.js";
import { bumpLastInbound } from "../whatsapp/webhook.js";

/** The subset of a Bot API Message we read. Everything is optional because the payload is external. */
export interface TgRawMessage {
  message_id?: unknown;
  date?: unknown;
  text?: unknown;
  chat?: { id?: unknown };
  reply_to_message?: { message_id?: unknown };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isId = (v: unknown): v is number | string => typeof v === "number" || (typeof v === "string" && v !== "");

/** "/start" (optionally "/start@botname" or with a deep-link payload) is the first thing a new chat sends. */
const START_RE = /^\/start(?:@\w+)?(?:\s|$)/;

export function toInboundFromTelegram(updateId: number, m: TgRawMessage, now: Date): InboundMessage {
  const replyTo = m.reply_to_message?.message_id;
  const base = {
    id: `tg:${updateId}`,
    from: String(m.chat?.id ?? ""),
    timestamp: unixToIso(typeof m.date === "number" ? String(m.date) : undefined, now),
    contextMessageId: isId(replyTo) ? String(replyTo) : null,
  };
  if (typeof m.text === "string") {
    return { ...base, type: "text", text: START_RE.test(m.text.trim()) ? "hi" : m.text };
  }
  return { ...base, type: "unsupported", text: null };
}

async function processUpdate(deps: Deps, updateId: number, m: TgRawMessage): Promise<void> {
  const chatId = String(m.chat?.id ?? "");
  const allowed = deps.config.TELEGRAM_CHAT_ID;
  if (!allowed || chatId !== allowed) {
    // Logged on purpose: during setup this is how I find my chat id (it's not a secret).
    deps.log.warn(
      allowed ? "telegram: ignored message from another chat" : "telegram: TELEGRAM_CHAT_ID not set, message ignored",
      { chatId, updateId },
    );
    return;
  }
  const now = deps.clock.now();
  if (!(await deps.store.processed.claim(`tg:${updateId}`, now.toISOString()))) {
    deps.log.info("telegram: duplicate update skipped", { updateId });
    return;
  }
  const msg = toInboundFromTelegram(updateId, m, now);
  // Same state key as WhatsApp, so get_status keeps reporting when I last wrote.
  await bumpLastInbound(deps, msg.timestamp);
  await deps.tasks.enqueueInbound(msg);
  deps.log.info("telegram: message enqueued", { updateId, type: msg.type });
}

/** POST /webhooks/telegram: Bot API updates (setWebhook with allowed_updates ["message"]). */
export const registerTelegramRoutes: RouteRegistrar = (app, deps) => {
  app.post("/webhooks/telegram", async (request, reply) => {
    const expected = deps.config.TELEGRAM_WEBHOOK_SECRET;
    const given = request.headers["x-telegram-bot-api-secret-token"];
    if (!expected || typeof given !== "string" || !safeEqual(given, expected)) {
      deps.log.warn("telegram: bad webhook secret");
      return reply.code(401).send({ error: "unauthorized" });
    }

    const update: unknown = request.body;
    const updateId = isObj(update) ? update.update_id : undefined;
    const message = isObj(update) ? update.message : undefined;
    if (typeof updateId !== "number" || !isObj(message)) {
      deps.log.info("telegram: update without a message ignored");
      return reply.code(200).send({ ok: true });
    }
    try {
      await processUpdate(deps, updateId, message as TgRawMessage);
    } catch (err) {
      deps.log.error("telegram: failed to process update", { updateId, err });
    }
    // Always 200 once authenticated: Telegram would otherwise keep redelivering the update.
    return reply.code(200).send({ ok: true });
  });
};
