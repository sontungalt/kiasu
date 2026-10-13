export type AccountId = "personal" | "school";
export const ACCOUNT_IDS: readonly AccountId[] = ["personal", "school"] as const;

export type ItemType = "task" | "deadline" | "event" | "info";
export type Urgency = "urgent" | "normal" | "low";
export type ItemStatus = "open" | "done" | "snoozed" | "dismissed";
export type Importance = "high" | "medium" | "low";

export type ItemSource =
  | { kind: "email"; account: AccountId; emailId: string; threadId: string; from: string }
  | { kind: "classroom"; courseId: string; courseName: string; courseWorkId: string | null; announcementId: string | null; link: string | null }
  | { kind: "manual" };

export interface Item {
  id: string;
  type: ItemType;
  title: string;
  details: string | null;
  dueAt: string | null; // UTC ISO
  startAt: string | null; // UTC ISO
  endAt: string | null; // UTC ISO
  urgency: Urgency;
  urgencyReason: string | null;
  status: ItemStatus;
  snoozedUntil: string | null;
  nudgedAt: string | null;
  alertedAt: string | null;
  source: ItemSource;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
}

export type EmailCategory =
  | "assignment" | "exam_test" | "teacher_message" | "school_admin" | "cca"
  | "event" | "personal" | "finance_receipt" | "account_security"
  | "newsletter" | "promotion" | "other";

export type TriageStatus = "pending" | "done" | "failed" | "skipped";

export interface EmailRecord {
  id: string; // Gmail message id
  account: AccountId;
  threadId: string;
  from: string;
  subject: string;
  receivedAt: string; // UTC ISO
  summary: string | null;
  category: EmailCategory | null;
  importance: Importance | null;
  needsReply: boolean;
  triageStatus: TriageStatus;
  triageAttempts: number;
  processedAt: string | null; // UTC ISO, set when triage finishes (done/failed/skipped)
}

export interface AccountState {
  id: AccountId;
  email: string;
  historyId: string | null;
  watchExpiresAt: string | null;
  lastSyncAt: string | null;
  authStatus: "ok" | "revoked";
}

export interface Reminder {
  id: string;
  text: string;
  fireAt: string; // UTC ISO
  status: "pending" | "sent" | "cancelled";
  itemId: string | null;
  createdAt: string;
}

export interface ConversationTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
}

export type TemplateName = "brief_ready" | "heads_up";
export interface TemplateRef {
  name: TemplateName;
  /** Positional body parameters {{1}}, {{2}}, ... */
  params: string[];
}

export type OutboxKind = "morning" | "evening" | "alert" | "reminder" | "nudge" | "system" | "reply";

export interface OutboxMessage {
  id: string;
  kind: OutboxKind;
  text: string;
  template: TemplateRef | null;
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface Settings {
  timezone: "Asia/Singapore";
  morningAt: string; // "HH:MM" SGT
  eveningAt: string;
  quietStart: string;
  quietEnd: string;
  vipSenders: string[]; // full addresses ("mr_tan@school.edu.sg") or domains ("@school.edu.sg"), lowercase
  urgentWindowHours: number;
  nudgeLeadHours: number;
  classroomSyncMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  timezone: "Asia/Singapore",
  morningAt: "06:30",
  eveningAt: "21:00",
  quietStart: "22:30",
  quietEnd: "06:30",
  vipSenders: [],
  urgentWindowHours: 36,
  nudgeLeadHours: 3,
  classroomSyncMinutes: 30,
};

/** Singleton state documents, keyed by name. */
export interface StateDocs {
  whatsapp: { lastInboundAt: string | null };
  lastList: { at: string; map: Record<string, string> }; // "1" -> itemId
  briefs: { lastMorningDate: string | null; lastEveningDate: string | null }; // SGT date keys
  classroom: { lastSyncAt: string | null };
  heldAlerts: { itemIds: string[] }; // alert-worthy items held during quiet hours (plan 04)
}

export interface CalendarEvent {
  id: string;
  account: AccountId;
  calendarId: string;
  title: string;
  startAt: string; // UTC ISO (for all-day: SGT midnight of the day, as UTC ISO)
  endAt: string;
  allDay: boolean;
  location: string | null;
}

export interface ParsedEmail {
  id: string;
  account: AccountId;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string; // UTC ISO
  text: string;
  attachments: string[]; // filenames
  labelIds: string[];
  truncated: boolean;
}

export interface EmailSearchHit {
  id: string;
  account: AccountId;
  threadId: string;
  from: string;
  subject: string;
  date: string; // UTC ISO
  snippet: string;
}

export interface InboundMessage {
  id: string; // WhatsApp message id (wamid...)
  from: string; // digits
  timestamp: string; // UTC ISO
  type: "text" | "button" | "unsupported";
  text: string | null; // text body, or the button's title for "button"
  contextMessageId: string | null; // id of the message being replied to, if any
}
