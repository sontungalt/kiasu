import { describe, it, expect } from "vitest";
import { createTelegramClient, renderTemplate, TelegramError, TG_TEXT_LIMIT } from "../../src/telegram/client.js";
import { loadConfig, type Config } from "../../src/config.js";
import { TEST_ENV } from "../helpers/env.js";

const TOKEN = "123456:AAH-test-token-value";
const config: Config = loadConfig({
  ...TEST_ENV,
  MESSENGER: "telegram",
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_CHAT_ID: "-1001234567890",
  TELEGRAM_WEBHOOK_SECRET: "tg_secret-0123456789",
});

interface Call { url: string; init: RequestInit; body: Record<string, unknown> }
type Reply = { status: number; body: unknown } | Error;

/** A fetch stand-in. Each call consumes the next queued reply; the default is a success. */
function fakeFetch(replies: Reply[] = []) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) as Record<string, unknown> });
    const next = replies.shift() ?? { status: 200, body: { ok: true, result: { message_id: 100 + calls.length } } };
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { impl, calls };
}

const PARSE_ERROR = {
  status: 400,
  body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 5" },
};

async function caught(p: Promise<unknown>): Promise<TelegramError> {
  try {
    await p;
  } catch (err) {
    return err as TelegramError;
  }
  throw new Error("expected a rejection");
}

describe("createTelegramClient", () => {
  it("sendText posts sendMessage with legacy Markdown and no link previews", async () => {
    const f = fakeFetch();
    const r = await createTelegramClient(config, f.impl).sendText("*Good morning!*\n_due today_");
    expect(r).toEqual({ messageId: "101" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(new Headers(f.calls[0]!.init.headers).get("content-type")).toBe("application/json");
    expect(f.calls[0]!.body).toEqual({
      chat_id: -1001234567890,
      text: "*Good morning!*\n_due today_",
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  });

  it("resends a chunk as plain text when Telegram can't parse its entities", async () => {
    const f = fakeFetch([PARSE_ERROR]);
    const r = await createTelegramClient(config, f.impl).sendText("snake_case *oops");
    expect(r).toEqual({ messageId: "102" });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.body).toEqual({ chat_id: -1001234567890, text: "snake_case *oops", disable_web_page_preview: true });
  });

  it("does not retry other 400s", async () => {
    const f = fakeFetch([{ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } }]);
    const err = await caught(createTelegramClient(config, f.impl).sendText("hi"));
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.status).toBe(400);
    expect(err.description).toBe("Bad Request: chat not found");
    expect(f.calls).toHaveLength(1);
  });

  it("splits text over 4096 characters and returns the last message id", async () => {
    expect(TG_TEXT_LIMIT).toBe(4096);
    const f = fakeFetch();
    const para = "x".repeat(3000);
    const r = await createTelegramClient(config, f.impl).sendText(`${para}\n\n${para}`);
    expect(f.calls.map((c) => c.body.text)).toEqual([para, para]);
    expect(r).toEqual({ messageId: "102" });
  });

  it("refuses empty text", async () => {
    const f = fakeFetch();
    await expect(createTelegramClient(config, f.impl).sendText("  ")).rejects.toThrow(TelegramError);
    expect(f.calls).toHaveLength(0);
  });

  it("429 carries retry_after", async () => {
    const f = fakeFetch([{ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } } }]);
    const err = await caught(createTelegramClient(config, f.impl).sendText("hi"));
    expect(err).toMatchObject({ name: "TelegramError", status: 429, retryAfter: 7 });
  });

  it("never puts the bot token in an error (network failure, bad body)", async () => {
    const net = fakeFetch([new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`)]);
    const e1 = await caught(createTelegramClient(config, net.impl).sendText("hi"));
    expect(e1).toBeInstanceOf(TelegramError);
    expect(e1.status).toBe(0);
    expect(`${e1.message} ${e1.description} ${e1.stack}`).not.toContain(TOKEN);

    const html = fakeFetch([{ status: 502, body: "<html>bad gateway</html>" }]);
    const e2 = await caught(createTelegramClient(config, html.impl).sendText("hi"));
    expect(e2.status).toBe(502);
    expect(e2.message).not.toContain(TOKEN);
    expect(e2.message).not.toContain("api.telegram.org");
  });

  it("errors when the response has no message id", async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true, result: {} } }]);
    await expect(createTelegramClient(config, f.impl).sendText("hi")).rejects.toThrow(/no message id/);
  });

  it("sendTemplate sends the rendered plain text (Telegram has no templates)", async () => {
    const f = fakeFetch();
    await createTelegramClient(config, f.impl).sendTemplate({ name: "brief_ready", params: ["morning", "3", "1"] });
    expect(f.calls[0]!.body).toEqual({
      chat_id: -1001234567890,
      text: "📚 Your morning brief is ready: 3 due today, 1 urgent.",
      disable_web_page_preview: true,
    });
  });

  it("needs a bot token to build, and a chat id to send", async () => {
    expect(() => createTelegramClient({ ...config, TELEGRAM_BOT_TOKEN: undefined })).toThrow(/TELEGRAM_BOT_TOKEN/);
    const f = fakeFetch();
    await expect(createTelegramClient({ ...config, TELEGRAM_CHAT_ID: undefined }, f.impl).sendText("hi"))
      .rejects.toThrow(/TELEGRAM_CHAT_ID/);
    expect(f.calls).toHaveLength(0);
  });
});

describe("renderTemplate", () => {
  it("renders brief_ready and heads_up", () => {
    expect(renderTemplate({ name: "brief_ready", params: ["evening", "2", "0"] })).toBe("📚 Your evening brief is ready: 2 due today, 0 urgent.");
    expect(renderTemplate({ name: "heads_up", params: ["Reconnect your school Google account"] }))
      .toBe("⚠️ Heads up: Reconnect your school Google account");
  });
  it("fills a missing parameter with -", () => {
    expect(renderTemplate({ name: "heads_up", params: [] })).toBe("⚠️ Heads up: -");
  });
});
