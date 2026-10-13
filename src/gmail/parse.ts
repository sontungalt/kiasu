import { convert } from "html-to-text";
import type { GmailMessage, GmailMessagePart } from "./api.js";
import type { AccountId, EmailSearchHit, ParsedEmail } from "../types.js";

export const MAX_TEXT_CHARS = 30_000;
/** HTML beyond this is cut before conversion; 500k chars of HTML is far more than 30k chars of text. */
export const MAX_HTML_INPUT_CHARS = 500_000;

type Header = { name?: string | null; value?: string | null };

const HTML_OPTIONS: Parameters<typeof convert>[1] = {
  wordwrap: false,
  selectors: [
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "script", format: "skip" },
    { selector: "td", format: "block" },
    { selector: "th", format: "block" },
    ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, options: { uppercase: false } })),
  ],
};

export function headerOf(headers: Header[] | null | undefined, name: string): string | null {
  const want = name.toLowerCase();
  return headers?.find((x) => (x.name ?? "").toLowerCase() === want)?.value ?? null;
}

export function decodeBase64Url(data: string, charset = "utf-8"): string {
  const bytes = Buffer.from(data, "base64url"); // Node also accepts the standard alphabet and padding here
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function charsetOf(part: GmailMessagePart): string {
  const ct = headerOf(part.headers, "Content-Type") ?? "";
  return /charset="?([^";\s]+)"?/i.exec(ct)?.[1] ?? "utf-8";
}

export function htmlToText(html: string): string {
  return convert(html, HTML_OPTIONS);
}

export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[​-‍⁠﻿͏­]/g, "") // zero-width padding used by newsletters
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface Collected {
  plain: string[];
  html: string[];
  attachments: string[];
}

function walk(part: GmailMessagePart, out: Collected): void {
  const filename = (part.filename ?? "").trim();
  if (filename) {
    out.attachments.push(filename);
    return;
  }
  if (part.parts && part.parts.length > 0) {
    for (const child of part.parts) walk(child, out);
    return;
  }
  const data = part.body?.data;
  if (!data) return;
  const mime = (part.mimeType ?? "").toLowerCase();
  if (mime === "text/plain") out.plain.push(decodeBase64Url(data, charsetOf(part)));
  else if (mime === "text/html") out.html.push(decodeBase64Url(data, charsetOf(part)));
}

/** internalDate (when Gmail received it) beats the sender-controlled Date header; then the fallback. */
function receivedAt(msg: GmailMessage, dateHeader: string | null, fallback: Date): string {
  const internal = Number(msg.internalDate);
  if (msg.internalDate && Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString();
  const fromHeader = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  if (Number.isFinite(fromHeader)) return new Date(fromHeader).toISOString();
  return fallback.toISOString();
}

export function parseGmailMessage(msg: GmailMessage, account: AccountId, fallbackDate: Date = new Date()): ParsedEmail {
  const headers = msg.payload?.headers;
  const out: Collected = { plain: [], html: [], attachments: [] };
  if (msg.payload) walk(msg.payload, out);

  let truncated = false;
  let text = cleanText(out.plain.join("\n\n"));
  if (!text && out.html.length > 0) {
    let html = out.html.join("\n");
    if (html.length > MAX_HTML_INPUT_CHARS) {
      html = html.slice(0, MAX_HTML_INPUT_CHARS);
      truncated = true;
    }
    text = cleanText(htmlToText(html));
  }
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    truncated = true;
  }

  return {
    id: msg.id ?? "",
    account,
    threadId: msg.threadId ?? msg.id ?? "",
    from: headerOf(headers, "From")?.trim() || "(unknown sender)",
    to: headerOf(headers, "To")?.trim() ?? "",
    subject: headerOf(headers, "Subject")?.trim() || "(no subject)",
    date: receivedAt(msg, headerOf(headers, "Date"), fallbackDate),
    text,
    attachments: out.attachments,
    labelIds: msg.labelIds ?? [],
    truncated,
  };
}

const codePoint = (n: number) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");

/** Gmail snippets are HTML-escaped. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => codePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, x: string) => codePoint(parseInt(x, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function searchHitFromMessage(msg: GmailMessage, account: AccountId, fallbackDate: Date = new Date(0)): EmailSearchHit {
  const headers = msg.payload?.headers;
  return {
    id: msg.id ?? "",
    account,
    threadId: msg.threadId ?? "",
    from: headerOf(headers, "From")?.trim() || "(unknown sender)",
    subject: headerOf(headers, "Subject")?.trim() || "(no subject)",
    date: receivedAt(msg, headerOf(headers, "Date"), fallbackDate),
    snippet: decodeEntities(msg.snippet ?? ""),
  };
}
