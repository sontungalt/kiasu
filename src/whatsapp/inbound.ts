import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { InboundMessage } from "../types.js";

/** The subset of a Cloud API webhook message we read. Fields are optional because the payload is external. */
export interface WaRawMessage {
  id: string;
  from: string;
  type: string;
  timestamp?: string;
  text?: { body?: unknown };
  button?: { text?: unknown; payload?: unknown };
  interactive?: {
    type?: unknown;
    button_reply?: { id?: unknown; title?: unknown };
    list_reply?: { id?: unknown; title?: unknown; description?: unknown };
  };
  context?: { from?: unknown; id?: unknown };
}

export interface WaRawStatus {
  id: string;
  status: string;
  recipient_id?: string;
  errors?: Array<{ code?: unknown; title?: unknown }>;
}

export interface WebhookContents {
  messages: WaRawMessage[];
  statuses: WaRawStatus[];
}

/** Message types that aren't something I "said": no agent call, no window update. */
export const IGNORED_TYPES: ReadonlySet<string> = new Set(["reaction", "system"]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Verifies Meta's `X-Hub-Signature-256: sha256=<hex>` header: an HMAC-SHA256 of the exact raw
 * request bytes, keyed with the app secret. Never pass a re-serialised body.
 */
export function verifyMetaSignature(rawBody: Buffer, header: string | string[] | undefined, appSecret: string): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const hex = header.slice("sha256=".length);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(hex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Constant-time string comparison of any lengths (hash both sides first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Collects every entry[].changes[].value.messages[] and .statuses[] item that has the fields we need. */
export function extractWebhook(payload: unknown): WebhookContents {
  const out: WebhookContents = { messages: [], statuses: [] };
  if (!isObj(payload)) return out;
  for (const entry of arr(payload.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || !isObj(change.value)) continue;
      for (const m of arr(change.value.messages)) {
        if (isObj(m) && isStr(m.id) && isStr(m.from) && isStr(m.type)) out.messages.push(m as unknown as WaRawMessage);
      }
      for (const s of arr(change.value.statuses)) {
        if (isObj(s) && isStr(s.id) && isStr(s.status)) out.statuses.push(s as unknown as WaRawStatus);
      }
    }
  }
  return out;
}

/** Webhook timestamps are unix seconds as a string ("1749416383"). Falls back to `now` if unusable. */
export function unixToIso(ts: string | undefined, now: Date): string {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : now.toISOString();
}

export function toInboundMessage(m: WaRawMessage, now: Date): InboundMessage {
  const base = {
    id: m.id,
    from: m.from,
    timestamp: unixToIso(m.timestamp, now),
    contextMessageId: isStr(m.context?.id) ? m.context.id : null,
  };
  if (m.type === "text" && typeof m.text?.body === "string") return { ...base, type: "text", text: m.text.body };
  // Template quick-reply tap.
  if (m.type === "button" && typeof m.button?.text === "string") return { ...base, type: "button", text: m.button.text };
  // Interactive reply buttons / list rows (not sent by v1, but mapped the same way).
  if (m.type === "interactive") {
    const title = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
    if (typeof title === "string") return { ...base, type: "button", text: title };
  }
  return { ...base, type: "unsupported", text: null };
}
