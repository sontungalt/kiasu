import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import type { Clock } from "./lib/clock.js";
import type { Logger } from "./lib/log.js";
import type { Store } from "./store/types.js";
import type {
  AccountId, CalendarEvent, EmailSearchHit, InboundMessage, Item, OutboxKind, ParsedEmail, TemplateRef,
} from "./types.js";

/** Returned by every sync. Callers pass `alerts` to Notifier.sendAlerts. */
export interface SyncResult {
  fetched: number;
  triaged: number;
  alerts: Item[];
}
export const EMPTY_SYNC: SyncResult = { fetched: 0, triaged: 0, alerts: [] };

/** Plan 01 (gmail-triage). */
export interface MailService {
  handlePush(notification: { emailAddress: string; historyId: string }): Promise<SyncResult>;
  syncAccount(account: AccountId): Promise<SyncResult>;
  retryPendingTriage(limit?: number): Promise<SyncResult>;
  renewWatchIfNeeded(account: AccountId): Promise<void>;
  search(query: string, opts?: { account?: AccountId; limit?: number }): Promise<EmailSearchHit[]>;
  read(emailId: string): Promise<ParsedEmail | null>;
}

/** Plan 02 (calendar-classroom). */
export interface CalendarService {
  listEvents(fromIso: string, toIso: string): Promise<CalendarEvent[]>;
}

/** Plan 02 (calendar-classroom). */
export interface ClassroomService {
  /** Syncs if CLASSROOM_ENABLED and last sync is older than settings.classroomSyncMinutes. */
  syncIfDue(): Promise<SyncResult>;
  sync(): Promise<SyncResult>;
}

/** Plan 03 (whatsapp). Recipient is always config.MY_WHATSAPP_NUMBER. */
export interface WhatsAppClient {
  sendText(text: string): Promise<{ messageId: string }>;
  sendTemplate(template: TemplateRef): Promise<{ messageId: string }>;
}

export interface OutboundMessage {
  kind: OutboxKind;
  text: string; // full free-form text
  template: TemplateRef; // sent instead when the 24h window is closed
}

/** Plan 03 (whatsapp). */
export interface Outbox {
  /** Sends `text` if the window is open; otherwise stores it pending and sends `template`. */
  deliver(msg: OutboundMessage): Promise<"sent" | "queued">;
  /** If the window is open, sends every pending message oldest-first. Returns count sent. */
  flush(): Promise<number>;
}

/** Plan 03 (whatsapp). */
export interface TaskQueue {
  enqueueInbound(msg: InboundMessage): Promise<void>;
}

/** Plan 04 (briefs-scheduler). Applies quiet hours and grouping, marks alertedAt. */
export interface Notifier {
  sendAlerts(items: Item[]): Promise<void>;
}

/** Plan 05 (chat-agent). */
export interface ChatAgent {
  reply(text: string): Promise<string>;
}

export interface Deps {
  config: Config;
  clock: Clock;
  log: Logger;
  store: Store;
  anthropic: Anthropic;
  mail: MailService;
  calendar: CalendarService;
  classroom: ClassroomService;
  whatsapp: WhatsAppClient;
  outbox: Outbox;
  tasks: TaskQueue;
  notifier: Notifier;
  agent: ChatAgent;
}
