import type { Config } from "../config.js";
import type { WhatsAppClient } from "../ports.js";
import type { TemplateName, TemplateRef } from "../types.js";
import { splitText } from "../whatsapp/split.js";

/** Telegram's sendMessage text limit (after entity parsing, so the raw Markdown length is a safe bound). */
export const TG_TEXT_LIMIT = 4096;

const API_BASE = "https://api.telegram.org";

/**
 * A failed Bot API call. `status` is the HTTP status (0 for network failures). The message never
 * contains the request URL, because the bot token is part of its path.
 */
export class TelegramError extends Error {
  readonly status: number;
  readonly description: string;
  readonly retryAfter: number | undefined;
  constructor(status: number, description: string, retryAfter?: number) {
    super(`Telegram API error (HTTP ${status}): ${description}`);
    this.name = "TelegramError";
    this.status = status;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

/** Plain-text versions of the WhatsApp templates (Telegram has no 24h window, so they're rarely needed). */
const TEMPLATE_TEXT: Record<TemplateName, string> = {
  brief_ready: "📚 Your {1} brief is ready: {2} due today, {3} urgent.",
  heads_up: "⚠️ Heads up: {1}",
};

export function renderTemplate(template: TemplateRef): string {
  return TEMPLATE_TEXT[template.name].replace(/\{(\d+)\}/g, (_m, n: string) => {
    const value = template.params[Number(n) - 1]?.trim();
    return value ? value : "-";
  });
}

/** Legacy Markdown (`*bold*`, `_italic_`) matches the WhatsApp-style formatting the app already writes. */
const isParseError = (err: TelegramError) => err.status === 400 && /can't parse entities/i.test(err.description);

interface BotApiResponse {
  ok?: unknown;
  result?: { message_id?: unknown };
  description?: unknown;
  parameters?: { retry_after?: unknown };
}

/**
 * A Telegram Bot API client behind the WhatsAppClient port, so the outbox, notifier and agent are
 * unchanged. Messages always go to TELEGRAM_CHAT_ID.
 */
export function createTelegramClient(config: Config, fetchImpl: typeof fetch = fetch): WhatsAppClient {
  const token = config.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram isn't configured: set TELEGRAM_BOT_TOKEN");
  // Defence in depth: whatever ends up in an error message, strip the token out of it.
  const redact = (text: string) => text.split(token).join("<bot-token>");

  function chatId(): number {
    const id = config.TELEGRAM_CHAT_ID;
    if (!id) throw new TelegramError(0, "TELEGRAM_CHAT_ID isn't set yet (run npm run telegram:chat-id)");
    return Number(id);
  }

  async function sendMessage(text: string, markdown: boolean): Promise<string> {
    const payload: Record<string, unknown> = { chat_id: chatId(), text };
    if (markdown) payload.parse_mode = "Markdown";
    payload.disable_web_page_preview = true;
    let res: Response;
    try {
      res = await fetchImpl(`${API_BASE}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Not the raw error: some fetch errors quote the URL, which contains the token.
      const name = err instanceof Error ? err.name : "Error";
      throw new TelegramError(0, redact(`network error (${name}): ${err instanceof Error ? err.message : String(err)}`));
    }
    const body = (await res.json().catch(() => null)) as BotApiResponse | null;
    if (!res.ok || body?.ok !== true) {
      const description = typeof body?.description === "string" ? redact(body.description) : "no error description";
      const retry = body?.parameters?.retry_after;
      throw new TelegramError(res.status, description, typeof retry === "number" ? retry : undefined);
    }
    const id = body.result?.message_id;
    if (typeof id !== "number" && typeof id !== "string") throw new TelegramError(res.status, "response had no message id");
    return String(id);
  }

  return {
    async sendText(text: string) {
      if (!text.trim()) throw new TelegramError(0, "refusing to send an empty message");
      let messageId = "";
      for (const chunk of splitText(text, TG_TEXT_LIMIT)) {
        try {
          messageId = await sendMessage(chunk, true);
        } catch (err) {
          // Unbalanced * or _ (e.g. "snake_case" in an email subject): send this chunk as plain text.
          if (!(err instanceof TelegramError && isParseError(err))) throw err;
          messageId = await sendMessage(chunk, false);
        }
      }
      return { messageId };
    },

    async sendTemplate(template: TemplateRef) {
      return { messageId: await sendMessage(renderTemplate(template), false) };
    },
  };
}
