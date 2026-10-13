import { describe, it, expect } from "vitest";
import {
  botApiUrl, callBotApi, chatIdReport, parseWebhookArg, redactToken, setWebhookPayload, webhookInfoReport, WEBHOOK_USAGE,
} from "../../scripts/lib/telegram.js";

const TOKEN = "123456:AAH-secret-token";

describe("botApiUrl / redactToken", () => {
  it("builds the method URL and redacts the token from any text", () => {
    expect(botApiUrl(TOKEN, "getUpdates")).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(redactToken(`failed: https://api.telegram.org/bot${TOKEN}/getMe`, TOKEN)).toBe(
      "failed: https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getMe",
    );
  });
});

describe("callBotApi", () => {
  it("POSTs JSON and returns the parsed body, never throwing the URL", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) as unknown });
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as typeof fetch;
    expect(await callBotApi(TOKEN, "setWebhook", { url: "https://x" }, fetchImpl)).toEqual({ ok: true, result: true });
    expect(seen).toEqual([{ url: botApiUrl(TOKEN, "setWebhook"), body: { url: "https://x" } }]);

    const failing = (async () => {
      throw new TypeError(`connect ECONNREFUSED for https://api.telegram.org/bot${TOKEN}/getMe`);
    }) as typeof fetch;
    const err = await callBotApi(TOKEN, "getMe", undefined, failing).catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).toMatch(/getMe/);
  });
});

describe("chatIdReport", () => {
  it("lists chat id, first name and text of recent messages, newest last", () => {
    const lines = chatIdReport({
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 111, type: "private", first_name: "Tung" }, text: "hi" } },
        { update_id: 2, edited_message: { chat: { id: 111 }, text: "ignored" } },
        { update_id: 3, message: { chat: { id: -100222, type: "group", title: "Class" }, from: { first_name: "Ann" }, text: "/start" } },
        { update_id: 4, message: { chat: { id: 111, first_name: "Tung" } } },
      ],
    });
    expect(lines).toEqual([
      "chat id 111  Tung: hi",
      "chat id -100222  Ann: /start",
      "chat id 111  Tung: (no text)",
      "",
      "Put your chat id in .env and in Render as TELEGRAM_CHAT_ID (e.g. TELEGRAM_CHAT_ID=111).",
    ]);
  });

  it("says what to do when there are no messages yet", () => {
    expect(chatIdReport({ ok: true, result: [] }).join("\n")).toMatch(/No messages yet\. Open your bot in Telegram, send it "hi"/);
  });

  it("explains how to delete the webhook when getUpdates conflicts with it, without the token", () => {
    const text = chatIdReport({
      ok: false, error_code: 409,
      description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
    }).join("\n");
    expect(text).toMatch(/webhook is set/i);
    expect(text).toContain("https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook");
    expect(text).toContain("npm run telegram:webhook");
    expect(text).not.toContain(TOKEN);
  });

  it("reports other API errors", () => {
    expect(chatIdReport({ ok: false, error_code: 401, description: "Unauthorized" }).join("\n")).toMatch(
      /Telegram said 401: Unauthorized[\s\S]*TELEGRAM_BOT_TOKEN/,
    );
  });
});

describe("parseWebhookArg", () => {
  it("takes the public base URL and appends /webhooks/telegram", () => {
    expect(parseWebhookArg(["https://kiasu-assistant.onrender.com/"])).toBe("https://kiasu-assistant.onrender.com/webhooks/telegram");
    expect(parseWebhookArg(["https://example.com/base//"])).toBe("https://example.com/base/webhooks/telegram");
  });
  it("requires an https URL", () => {
    expect(() => parseWebhookArg([])).toThrow(WEBHOOK_USAGE);
    expect(() => parseWebhookArg(["http://kiasu.onrender.com"])).toThrow(/https/);
    expect(() => parseWebhookArg(["not a url"])).toThrow(WEBHOOK_USAGE);
  });
});

describe("setWebhookPayload", () => {
  it("sets the secret, only message updates, and drops the backlog", () => {
    expect(setWebhookPayload("https://x/webhooks/telegram", "s".repeat(64))).toEqual({
      url: "https://x/webhooks/telegram",
      secret_token: "s".repeat(64),
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });
  });
  it("rejects a secret Telegram wouldn't accept", () => {
    expect(() => setWebhookPayload("https://x", "short")).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(() => setWebhookPayload("https://x", "")).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });
});

describe("webhookInfoReport", () => {
  it("prints the useful fields of getWebhookInfo", () => {
    const lines = webhookInfoReport({
      ok: true,
      result: {
        url: "https://x/webhooks/telegram", has_custom_certificate: false, pending_update_count: 0,
        allowed_updates: ["message"], last_error_date: 1791936000, last_error_message: "Wrong response from the webhook: 401 Unauthorized",
      },
    });
    expect(lines).toEqual([
      "url: https://x/webhooks/telegram",
      "pending updates: 0",
      "allowed updates: message",
      "last error: 2026-10-14T00:00:00.000Z Wrong response from the webhook: 401 Unauthorized",
      "   A 401 means TELEGRAM_WEBHOOK_SECRET differs between .env and the server. Make them equal and run this again.",
    ]);
  });
  it("says when no webhook is set and when there's no error", () => {
    expect(webhookInfoReport({ ok: true, result: { url: "", pending_update_count: 3 } })).toEqual([
      "url: (none set)", "pending updates: 3", "allowed updates: (all)", "last error: none",
    ]);
  });
});
