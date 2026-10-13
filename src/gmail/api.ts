import { google, type gmail_v1 } from "googleapis";
import type { Config } from "../config.js";
import type { AccountId } from "../types.js";
import { googleAuthFor } from "../google/auth.js";

export type GmailMessage = gmail_v1.Schema$Message;
export type GmailMessagePart = gmail_v1.Schema$MessagePart;

export interface MessageRef {
  id: string;
  threadId: string;
}

/** The only Gmail calls this app makes. All read-only. */
export interface GmailApi {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  /** users.watch on INBOX. `expiration` is epoch ms as a string. */
  watch(topicName: string): Promise<{ historyId: string; expiration: string }>;
  /** Every page of INBOX messageAdded history after startHistoryId. Throws a 404-status error when startHistoryId is too old. */
  listHistory(startHistoryId: string): Promise<{ added: MessageRef[]; historyId: string }>;
  /** messages.list with Gmail `q` syntax, newest first, up to maxResults. */
  listMessages(q: string, maxResults: number): Promise<MessageRef[]>;
  getMessage(id: string, format: "full" | "metadata"): Promise<GmailMessage>;
}

export type GmailApiFactory = (account: AccountId) => GmailApi | null;

export const METADATA_HEADERS = ["From", "To", "Subject", "Date"];
const MAX_HISTORY_PAGES = 50;

export function httpStatusOf(err: unknown): number | null {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } } | null;
  for (const v of [e?.status, e?.response?.status, e?.code]) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isInteger(n) && n >= 100 && n < 600) return n;
  }
  return null;
}

/** Safe-to-log summary of an error: never includes request or response bodies. */
export function errInfo(err: unknown): { name: string; status: number | null; message: string } {
  const e = err as { name?: unknown; message?: unknown } | null;
  return {
    name: typeof e?.name === "string" ? e.name : "UnknownError",
    status: httpStatusOf(err),
    message: (typeof e?.message === "string" ? e.message : String(err)).slice(0, 200),
  };
}

export function gmailApiFromClient(gmail: gmail_v1.Gmail): GmailApi {
  return {
    async getProfile() {
      const { data } = await gmail.users.getProfile({ userId: "me" });
      return { emailAddress: data.emailAddress ?? "", historyId: data.historyId ?? "" };
    },

    async watch(topicName) {
      const { data } = await gmail.users.watch({
        userId: "me",
        requestBody: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "include" },
      });
      return { historyId: data.historyId ?? "", expiration: data.expiration ?? "" };
    },

    async listHistory(startHistoryId) {
      const added: MessageRef[] = [];
      const seen = new Set<string>();
      let historyId = startHistoryId;
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
        const { data } = await gmail.users.history.list({
          userId: "me",
          startHistoryId,
          historyTypes: ["messageAdded"],
          labelId: "INBOX",
          maxResults: 500,
          pageToken,
        });
        for (const h of data.history ?? []) {
          for (const a of h.messagesAdded ?? []) {
            const id = a.message?.id;
            const threadId = a.message?.threadId;
            if (id && threadId && !seen.has(id)) {
              seen.add(id);
              added.push({ id, threadId });
            }
          }
        }
        if (data.historyId) historyId = data.historyId;
        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }
      return { added, historyId };
    },

    async listMessages(q, maxResults) {
      const out: MessageRef[] = [];
      let pageToken: string | undefined;
      while (out.length < maxResults) {
        const { data } = await gmail.users.messages.list({
          userId: "me",
          q,
          maxResults: Math.min(500, maxResults - out.length),
          pageToken,
        });
        for (const m of data.messages ?? []) {
          if (m.id && m.threadId && out.length < maxResults) out.push({ id: m.id, threadId: m.threadId });
        }
        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }
      return out;
    },

    async getMessage(id, format) {
      const { data } = await gmail.users.messages.get({
        userId: "me",
        id,
        format,
        ...(format === "metadata" ? { metadataHeaders: METADATA_HEADERS } : {}),
      });
      return data;
    },
  };
}

/** One cached GmailApi per account (keeps the OAuth access token warm). Null if the account has no refresh token. */
export function createGmailApiFactory(config: Config): GmailApiFactory {
  const cache = new Map<AccountId, GmailApi | null>();
  return (account) => {
    if (!cache.has(account)) {
      const auth = googleAuthFor(account, config);
      cache.set(account, auth ? gmailApiFromClient(google.gmail({ version: "v1", auth })) : null);
    }
    return cache.get(account) ?? null;
  };
}
