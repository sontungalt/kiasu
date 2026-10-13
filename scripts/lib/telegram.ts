/** Pure helpers for scripts/telegram-chat-id.ts and scripts/telegram-webhook.ts. They never print the bot token. */

const API_BASE = "https://api.telegram.org";
const TOKEN_PLACEHOLDER = "<TELEGRAM_BOT_TOKEN>";
const SECRET_RE = /^[A-Za-z0-9_-]{16,256}$/;

export const WEBHOOK_PATH = "/webhooks/telegram";
export const WEBHOOK_USAGE = "Usage: npm run telegram:webhook -- https://<your-service>.onrender.com";

export interface BotApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export function botApiUrl(token: string, method: string): string {
  return `${API_BASE}/bot${token}/${method}`;
}

export function redactToken(text: string, token: string): string {
  return token ? text.split(token).join(TOKEN_PLACEHOLDER) : text;
}

/** Calls a Bot API method. Errors name the method but never contain the URL (it holds the token). */
export async function callBotApi<T = unknown>(
  token: string,
  method: string,
  params?: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<BotApiResponse<T>> {
  let res: Response;
  try {
    res = await fetchImpl(botApiUrl(token, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(redactToken(`Telegram ${method} failed: ${err instanceof Error ? err.message : String(err)}`, token));
  }
  const body = (await res.json().catch(() => null)) as BotApiResponse<T> | null;
  return body ?? { ok: false, error_code: res.status, description: `HTTP ${res.status} with no JSON body` };
}

/** The parts of a Bot API Update we read; other fields are allowed and ignored. */
interface TgChat { id?: unknown; first_name?: unknown; title?: unknown; [key: string]: unknown }
export interface TgUpdate {
  update_id?: unknown;
  message?: { chat?: TgChat; from?: { first_name?: unknown; [key: string]: unknown }; text?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Lines describing getUpdates: one per recent message, or what to do when it failed. */
export function chatIdReport(res: BotApiResponse<TgUpdate[]>): string[] {
  if (!res.ok) {
    if (res.error_code === 409) {
      return [
        "A webhook is set for this bot, so getUpdates can't be used while it is active.",
        "Delete the webhook (open this in a browser, with your token in place of the placeholder):",
        `  ${API_BASE}/bot${TOKEN_PLACEHOLDER}/deleteWebhook`,
        "Then send the bot a message and run this again. Afterwards, set the webhook back with:",
        "  npm run telegram:webhook -- <your public base URL>",
      ];
    }
    return [`Telegram said ${res.error_code ?? "?"}: ${res.description ?? "unknown error"}`, "Check TELEGRAM_BOT_TOKEN in .env."];
  }
  const lines: string[] = [];
  let lastId: string | null = null;
  for (const u of res.result ?? []) {
    const m = u.message;
    if (!m || (typeof m.chat?.id !== "number" && typeof m.chat?.id !== "string")) continue;
    const id = String(m.chat.id);
    const name = str(m.from?.first_name) ?? str(m.chat.first_name) ?? str(m.chat.title) ?? "?";
    lines.push(`chat id ${id}  ${name}: ${str(m.text) ?? "(no text)"}`);
    lastId = id;
  }
  if (!lastId) return ['No messages yet. Open your bot in Telegram, send it "hi", then run this again.'];
  lines.push("", `Put your chat id in .env and in Render as TELEGRAM_CHAT_ID (e.g. TELEGRAM_CHAT_ID=${lastId}).`);
  return lines;
}

/** The webhook URL for a public base URL. Telegram only delivers to https. */
export function parseWebhookArg(argv: string[]): string {
  const raw = argv.find((a) => !a.startsWith("--"));
  if (!raw) throw new Error(WEBHOOK_USAGE);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(WEBHOOK_USAGE);
  }
  if (url.protocol !== "https:") throw new Error(`Telegram webhooks must use https. ${WEBHOOK_USAGE}`);
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return `${base}${WEBHOOK_PATH}`;
}

export function setWebhookPayload(url: string, secret: string): Record<string, unknown> {
  if (!SECRET_RE.test(secret)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must be 16-256 characters of A-Z, a-z, 0-9, _ and - (openssl rand -hex 32)");
  }
  return { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true };
}

interface WebhookInfo {
  [key: string]: unknown;
  url?: unknown;
  pending_update_count?: unknown;
  allowed_updates?: unknown;
  last_error_date?: unknown;
  last_error_message?: unknown;
}

/** getWebhookInfo, minus anything noisy. (It never contains the token.) */
export function webhookInfoReport(res: BotApiResponse<WebhookInfo>): string[] {
  if (!res.ok || !res.result) return [`getWebhookInfo failed: ${res.error_code ?? "?"} ${res.description ?? ""}`.trim()];
  const info = res.result;
  const allowed = Array.isArray(info.allowed_updates) && info.allowed_updates.length > 0 ? info.allowed_updates.join(", ") : "(all)";
  const lines = [
    `url: ${str(info.url) ?? "(none set)"}`,
    `pending updates: ${typeof info.pending_update_count === "number" ? info.pending_update_count : "?"}`,
    `allowed updates: ${allowed}`,
  ];
  const errMsg = str(info.last_error_message);
  if (!errMsg) {
    lines.push("last error: none");
    return lines;
  }
  const when = typeof info.last_error_date === "number" ? `${new Date(info.last_error_date * 1000).toISOString()} ` : "";
  lines.push(`last error: ${when}${errMsg}`);
  if (/\b401\b/.test(errMsg)) {
    lines.push("   A 401 means TELEGRAM_WEBHOOK_SECRET differs between .env and the server. Make them equal and run this again.");
  }
  return lines;
}
