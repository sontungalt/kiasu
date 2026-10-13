import type { Config } from "../config.js";
import type { WhatsAppClient } from "../ports.js";
import type { TemplateRef } from "../types.js";
import { splitText } from "./split.js";

/** A failed Graph API call. `code` is Meta's error code (null for network/parse failures). */
export class WhatsAppError extends Error {
  readonly status: number;
  readonly code: number | null;
  constructor(status: number, code: number | null, message: string) {
    super(message);
    this.name = "WhatsAppError";
    this.status = status;
    this.code = code;
  }
}

/** Graph API error codes we act on or log. See docs/whatsapp-templates.md for sources. */
export const WA_ERROR = {
  REENGAGEMENT: 131047, // more than 24h since the recipient last replied: send a template instead
  UNDELIVERABLE: 131026,
  PAIR_RATE_LIMIT: 131056, // too many messages to the same recipient in a short time
  THROUGHPUT_LIMIT: 130429,
  TOKEN_EXPIRED: 190,
  TEMPLATE_PARAM_COUNT: 132000,
  TEMPLATE_MISSING: 132001,
  TEMPLATE_PARAM_FORMAT: 132018,
} as const;

/** True when Meta says the 24h customer-service window is closed. */
export function isWindowClosedError(err: unknown): boolean {
  return err instanceof WhatsAppError && err.code === WA_ERROR.REENGAGEMENT;
}

const TEMPLATE_PARAM_MAX = 300;

/**
 * Template parameters may not contain newlines, tabs or 5+ consecutive spaces (error 132018),
 * and may not be empty. Collapse whitespace, substitute "-" for empty, cap the length.
 */
export function sanitiseTemplateParam(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return "-";
  const codePoints = Array.from(flat);
  return codePoints.length > TEMPLATE_PARAM_MAX ? `${codePoints.slice(0, TEMPLATE_PARAM_MAX - 1).join("")}…` : flat;
}

interface GraphResponse {
  messages?: Array<{ id?: unknown }>;
  error?: { message?: unknown; code?: unknown; error_data?: { details?: unknown } };
}

export function createWhatsAppClient(config: Config, fetchImpl: typeof fetch = fetch): WhatsAppClient {
  const { WA_PHONE_NUMBER_ID: phoneNumberId, WA_ACCESS_TOKEN: accessToken, MY_WHATSAPP_NUMBER: to } = config;
  if (!phoneNumberId || !accessToken || !to) {
    throw new Error("WhatsApp isn't configured: set WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN and MY_WHATSAPP_NUMBER");
  }
  const url = `https://graph.facebook.com/${config.WA_GRAPH_VERSION}/${phoneNumberId}/messages`;

  async function post(payload: Record<string, unknown>): Promise<string> {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          ...payload,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new WhatsAppError(0, null, `WhatsApp network error: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = (await res.json().catch(() => null)) as GraphResponse | null;
    if (!res.ok) {
      const e = body?.error;
      const code = typeof e?.code === "number" ? e.code : null;
      const detail = typeof e?.error_data?.details === "string" ? e.error_data.details
        : typeof e?.message === "string" ? e.message : "no error body";
      // The code goes into the message too, because the logger only serialises message/name/stack.
      throw new WhatsAppError(res.status, code, `WhatsApp API error ${code ?? "?"} (HTTP ${res.status}): ${detail}`);
    }
    const id = body?.messages?.[0]?.id;
    if (typeof id !== "string") throw new WhatsAppError(res.status, null, "WhatsApp API response had no message id");
    return id;
  }

  return {
    async sendText(text: string) {
      if (!text.trim()) throw new WhatsAppError(0, null, "Refusing to send an empty WhatsApp message");
      let messageId = "";
      for (const chunk of splitText(text)) {
        messageId = await post({ type: "text", text: { body: chunk, preview_url: false } });
      }
      return { messageId };
    },

    async sendTemplate(template: TemplateRef) {
      // Quick-reply buttons have no parameters, so only the body component is sent.
      const components = template.params.length > 0
        ? [{ type: "body", parameters: template.params.map((p) => ({ type: "text", text: sanitiseTemplateParam(p) })) }]
        : [];
      const messageId = await post({
        type: "template",
        template: { name: template.name, language: { code: "en" }, components },
      });
      return { messageId };
    },
  };
}
