import type {
  AccountId, AccountState, ConversationTurn, EmailRecord, Item, ItemSource, ItemStatus,
  OutboxMessage, Reminder, Settings, StateDocs,
} from "../types.js";

export interface ItemFilter {
  status?: ItemStatus[];
  dueBefore?: string; // UTC ISO, exclusive
  dueAfter?: string; // UTC ISO, inclusive
  hasDue?: boolean;
  account?: AccountId; // matches email-sourced items from that account; classroom counts as "school"
  sourceKind?: ItemSource["kind"];
  query?: string; // case-insensitive substring of title/details
  limit?: number;
}

export interface Store {
  accounts: {
    get(id: AccountId): Promise<AccountState | null>;
    upsert(account: AccountState): Promise<void>;
  };
  emails: {
    get(id: string): Promise<EmailRecord | null>;
    upsert(email: EmailRecord): Promise<void>;
    listPending(limit: number): Promise<EmailRecord[]>; // triageStatus === "pending", oldest receivedAt first
    listImportantSince(sinceIso: string): Promise<EmailRecord[]>; // done, importance high|medium, processedAt >= since, newest first
    listFailedSince(sinceIso: string): Promise<EmailRecord[]>; // triageStatus === "failed", processedAt >= since, newest first
  };
  items: {
    get(id: string): Promise<Item | null>;
    create(data: Omit<Item, "id">): Promise<Item>;
    update(id: string, patch: Partial<Omit<Item, "id">>): Promise<void>;
    findByDedupeKey(key: string): Promise<Item | null>;
    listByThread(threadId: string): Promise<Item[]>;
    list(filter: ItemFilter): Promise<Item[]>; // sorted by sortItems
  };
  reminders: {
    create(data: Omit<Reminder, "id">): Promise<Reminder>;
    update(id: string, patch: Partial<Omit<Reminder, "id">>): Promise<void>;
    listDue(nowIso: string): Promise<Reminder[]>; // pending && fireAt <= now, oldest first
    listPending(): Promise<Reminder[]>;
  };
  conversation: {
    append(turn: Omit<ConversationTurn, "id">): Promise<void>;
    recent(n: number): Promise<ConversationTurn[]>; // oldest first
  };
  outbox: {
    create(msg: Omit<OutboxMessage, "id">): Promise<OutboxMessage>;
    update(id: string, patch: Partial<Omit<OutboxMessage, "id">>): Promise<void>;
    listPending(): Promise<OutboxMessage[]>; // oldest first
  };
  state: {
    get<K extends keyof StateDocs>(key: K): Promise<StateDocs[K] | null>;
    set<K extends keyof StateDocs>(key: K, value: StateDocs[K]): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>; // stored doc merged over DEFAULT_SETTINGS
  };
  processed: {
    /** Atomically records `key`. Returns true the first time, false if it already existed. */
    claim(key: string, atIso: string): Promise<boolean>;
    purgeOlderThan(iso: string): Promise<number>;
  };
}
