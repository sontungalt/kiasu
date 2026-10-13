import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { registerTelegramRoutes, toInboundFromTelegram } from "../../src/telegram/webhook.js";
import { createLogger } from "../../src/lib/log.js";
import type { TaskQueue } from "../../src/ports.js";
import type { InboundMessage } from "../../src/types.js";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";

const SECRET = "tg_secret-0123456789abcdef";
const CHAT = "123456789";
const T0 = 1791936000; // 2026-10-14T00:00:00Z, the test clock's "now"
const NOW = new Date(T0 * 1000);

function update(updateId: number, message: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
  return { update_id: updateId, ...(message ? { message } : {}), ...extra };
}

const textMsg = (id: number, text: string, chatId: number = Number(CHAT), date = T0) => ({
  message_id: id, date, text,
  chat: { id: chatId, type: "private", first_name: "Me" },
  from: { id: chatId, is_bot: false, first_name: "Me" },
});

describe("toInboundFromTelegram", () => {
  it("maps text, /start, non-text and replies", () => {
    expect(toInboundFromTelegram(7, textMsg(1, "what's due?"), NOW)).toEqual({
      id: "tg:7", from: CHAT, timestamp: "2026-10-14T00:00:00.000Z", type: "text", text: "what's due?", contextMessageId: null,
    });
    expect(toInboundFromTelegram(8, textMsg(2, "/start"), NOW)).toMatchObject({ type: "text", text: "hi" });
    expect(toInboundFromTelegram(9, textMsg(3, "/start@kiasu_bot"), NOW)).toMatchObject({ type: "text", text: "hi" });
    expect(toInboundFromTelegram(10, textMsg(4, "/started reading"), NOW)).toMatchObject({ text: "/started reading" });
    const { text: _t, ...photo } = { ...textMsg(5, ""), photo: [{ file_id: "x" }] };
    expect(toInboundFromTelegram(11, photo, NOW)).toMatchObject({ id: "tg:11", type: "unsupported", text: null });
    expect(toInboundFromTelegram(12, { ...textMsg(6, "done"), reply_to_message: { message_id: 555 } }, NOW))
      .toMatchObject({ contextMessageId: "555" });
    expect(toInboundFromTelegram(13, { ...textMsg(7, "x"), date: undefined }, NOW).timestamp).toBe(NOW.toISOString());
  });
});

describe("Telegram webhook route", () => {
  let deps: TestDeps;
  let app: FastifyInstance;
  let enqueued: InboundMessage[];
  let failNext: boolean;
  let logs: Array<Record<string, unknown>>;

  async function start(env: { chatId?: string; secret?: string } = {}) {
    enqueued = [];
    failNext = false;
    logs = [];
    const tasks: TaskQueue = {
      enqueueInbound: async (m) => {
        if (failNext) {
          failNext = false;
          throw new Error("queue down");
        }
        enqueued.push(m);
      },
    };
    deps = makeTestDeps({ tasks, log: createLogger({}, (l) => logs.push(JSON.parse(l) as Record<string, unknown>)) });
    deps.config = {
      ...deps.config,
      MESSENGER: "telegram",
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_WEBHOOK_SECRET: "secret" in env ? env.secret : SECRET,
      TELEGRAM_CHAT_ID: "chatId" in env ? env.chatId : CHAT,
    };
    app = await buildServer(deps, [registerTelegramRoutes]);
  }

  beforeEach(() => start());
  afterEach(() => app.close());

  const post = (body: unknown, secret: string | null = SECRET) =>
    app.inject({
      method: "POST",
      url: "/webhooks/telegram",
      payload: body as Record<string, unknown>,
      headers: secret === null ? {} : { "x-telegram-bot-api-secret-token": secret },
    });

  it("401 without the secret header or with a wrong one, and nothing is processed", async () => {
    expect((await post(update(1, textMsg(1, "hi")), null)).statusCode).toBe(401);
    expect((await post(update(1, textMsg(1, "hi")), "wrong-secret-value-123")).statusCode).toBe(401);
    expect((await post(update(1, textMsg(1, "hi")), `${SECRET}x`)).statusCode).toBe(401);
    expect(enqueued).toEqual([]);
  });

  it("401 when TELEGRAM_WEBHOOK_SECRET isn't configured", async () => {
    await app.close();
    await start({ secret: undefined });
    expect((await post(update(1, textMsg(1, "hi")), "")).statusCode).toBe(401);
  });

  it("enqueues my message, records the window time and dedupes retries", async () => {
    const res = await post(update(42, textMsg(1, "what's due this week?", Number(CHAT), T0 - 60)));
    expect(res.statusCode).toBe(200);
    expect(enqueued).toEqual([{
      id: "tg:42", from: CHAT, timestamp: "2026-10-13T23:59:00.000Z", type: "text", text: "what's due this week?", contextMessageId: null,
    }]);
    expect(await deps.store.state.get("whatsapp")).toEqual({ lastInboundAt: "2026-10-13T23:59:00.000Z" });
    expect((await post(update(42, textMsg(1, "what's due this week?")))).statusCode).toBe(200);
    expect(enqueued).toHaveLength(1);
  });

  it("never moves lastInboundAt backwards", async () => {
    await post(update(1, textMsg(1, "new", Number(CHAT), T0)));
    await post(update(2, textMsg(2, "old", Number(CHAT), T0 - 3600)));
    expect(await deps.store.state.get("whatsapp")).toEqual({ lastInboundAt: "2026-10-14T00:00:00.000Z" });
  });

  it("ignores other chats and logs their chat id at warn level", async () => {
    const res = await post(update(5, textMsg(1, "hello", 999)));
    expect(res.statusCode).toBe(200);
    expect(enqueued).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ severity: "WARNING", chatId: "999" }));
  });

  it("with TELEGRAM_CHAT_ID unset (setup), ignores everything and logs the chat id", async () => {
    await app.close();
    await start({ chatId: undefined });
    expect((await post(update(5, textMsg(1, "hello")))).statusCode).toBe(200);
    expect(enqueued).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ severity: "WARNING", chatId: CHAT }));
    expect(await deps.store.state.get("whatsapp")).toBeNull();
  });

  it("acknowledges updates without a message (edited messages, etc.)", async () => {
    expect((await post(update(6, undefined, { edited_message: textMsg(1, "edit") }))).statusCode).toBe(200);
    expect((await post({ nonsense: true })).statusCode).toBe(200);
    expect(enqueued).toEqual([]);
  });

  it("still answers 200 when processing fails, and logs it", async () => {
    failNext = true;
    expect((await post(update(7, textMsg(1, "hi")))).statusCode).toBe(200);
    expect(logs).toContainEqual(expect.objectContaining({ severity: "ERROR", updateId: 7 }));
  });
});
