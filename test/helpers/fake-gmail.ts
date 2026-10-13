import type { GmailApi, GmailMessage, MessageRef } from "../../src/gmail/api.js";

export function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`Request failed with status code ${status}`), { status });
}

/** The shape google-auth-library throws when a refresh token is revoked or expired. */
export function invalidGrantError(): Error {
  return Object.assign(new Error("invalid_grant"), {
    response: { data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } },
  });
}

export interface BuildMessageOpts {
  id: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  labelIds?: string[];
  receivedAt?: string; // ISO; becomes internalDate
}

/** A minimal full-format Gmail message with a single text/plain body. */
export function buildMessage(o: BuildMessageOpts): GmailMessage {
  const text = o.text ?? "Please submit the form.";
  return {
    id: o.id,
    threadId: o.threadId ?? `t-${o.id}`,
    labelIds: o.labelIds ?? ["INBOX", "UNREAD"],
    snippet: text.slice(0, 100),
    internalDate: String(Date.parse(o.receivedAt ?? "2026-10-13T23:30:00Z")),
    payload: {
      partId: "",
      mimeType: "text/plain",
      filename: "",
      headers: [
        { name: "From", value: o.from ?? "Mr Tan <tan@school.edu.sg>" },
        { name: "To", value: o.to ?? "me@students.school.edu.sg" },
        { name: "Subject", value: o.subject ?? `Subject ${o.id}` },
        { name: "Content-Type", value: "text/plain; charset=UTF-8" },
      ],
      body: { size: text.length, data: Buffer.from(text, "utf8").toString("base64url") },
    },
  };
}

/** In-memory Gmail mailbox. Every addMessage bumps historyId by one. */
export class FakeGmailApi implements GmailApi {
  historyId = "100";
  watchExpiration = String(Date.parse("2026-10-21T00:00:00Z"));
  staleHistory = false;
  revoked = false;
  /** When set, this many getMessage calls succeed, then the account behaves as revoked. */
  getsBeforeRevoke: number | null = null;
  failGet = new Map<string, unknown>();
  failListMessages: unknown = null;
  readonly calls: string[] = [];
  private readonly messages = new Map<string, GmailMessage>();
  private readonly added: Array<{ at: number; ref: MessageRef }> = [];

  constructor(public email = "me@example.com") {}

  addMessage(msg: GmailMessage): void {
    if (!msg.id || !msg.threadId) throw new Error("message needs id and threadId");
    this.messages.set(msg.id, msg);
    const at = Number(this.historyId) + 1;
    this.historyId = String(at);
    this.added.push({ at, ref: { id: msg.id, threadId: msg.threadId } });
  }

  private guard(call: string): void {
    this.calls.push(call);
    if (this.revoked) throw invalidGrantError();
  }

  async getProfile() {
    this.guard("getProfile");
    return { emailAddress: this.email, historyId: this.historyId };
  }

  async watch(topicName: string) {
    this.guard(`watch:${topicName}`);
    return { historyId: this.historyId, expiration: this.watchExpiration };
  }

  async listHistory(startHistoryId: string) {
    this.guard(`listHistory:${startHistoryId}`);
    if (this.staleHistory) throw httpError(404);
    return {
      added: this.added.filter((a) => a.at > Number(startHistoryId)).map((a) => a.ref),
      historyId: this.historyId,
    };
  }

  async listMessages(q: string, maxResults: number) {
    this.guard(`listMessages:${q}`);
    if (this.failListMessages) throw this.failListMessages;
    return [...this.messages.values()]
      .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
      .slice(0, maxResults)
      .map((m) => ({ id: m.id!, threadId: m.threadId! }));
  }

  async getMessage(id: string, format: "full" | "metadata") {
    if (this.getsBeforeRevoke !== null) {
      if (this.getsBeforeRevoke <= 0) this.revoked = true;
      else this.getsBeforeRevoke--;
    }
    this.guard(`getMessage:${id}:${format}`);
    const fail = this.failGet.get(id);
    if (fail) throw fail;
    const m = this.messages.get(id);
    if (!m) throw httpError(404);
    return structuredClone(m);
  }
}
