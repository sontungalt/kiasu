import { randomUUID } from "node:crypto";
import type { Store, ItemFilter } from "./types.js";
import { applyFilter } from "./filter.js";
import type {
  AccountId, AccountState, ConversationTurn, EmailRecord, Item, OutboxMessage, Reminder, Settings, StateDocs,
} from "../types.js";
import { DEFAULT_SETTINGS } from "../types.js";

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  private accountMap = new Map<AccountId, AccountState>();
  private emailMap = new Map<string, EmailRecord>();
  private itemMap = new Map<string, Item>();
  private reminderMap = new Map<string, Reminder>();
  private turns: ConversationTurn[] = [];
  private outboxMap = new Map<string, OutboxMessage>();
  private stateMap = new Map<string, unknown>();
  private processedMap = new Map<string, string>();
  settingsOverride: Partial<Settings> = {};

  accounts: Store["accounts"] = {
    get: async (id) => clone(this.accountMap.get(id) ?? null),
    upsert: async (a) => void this.accountMap.set(a.id, clone(a)),
  };

  emails: Store["emails"] = {
    get: async (id) => clone(this.emailMap.get(id) ?? null),
    upsert: async (e) => void this.emailMap.set(e.id, clone(e)),
    listPending: async (limit) =>
      clone([...this.emailMap.values()].filter((e) => e.triageStatus === "pending")
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).slice(0, limit)),
    listImportantSince: async (since) =>
      clone([...this.emailMap.values()]
        .filter((e) => e.triageStatus === "done" && (e.importance === "high" || e.importance === "medium")
          && e.processedAt !== null && e.processedAt >= since)
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))),
  };

  items: Store["items"] = {
    get: async (id) => clone(this.itemMap.get(id) ?? null),
    create: async (data) => {
      const item: Item = { ...clone(data), id: randomUUID() };
      this.itemMap.set(item.id, item);
      return clone(item);
    },
    update: async (id, patch) => {
      const cur = this.itemMap.get(id);
      if (!cur) throw new Error(`Item not found: ${id}`);
      this.itemMap.set(id, { ...cur, ...clone(patch) });
    },
    findByDedupeKey: async (key) => clone([...this.itemMap.values()].find((i) => i.dedupeKey === key) ?? null),
    listByThread: async (threadId) =>
      clone([...this.itemMap.values()].filter((i) => i.source.kind === "email" && i.source.threadId === threadId)),
    list: async (filter: ItemFilter) => clone(applyFilter([...this.itemMap.values()], filter)),
  };

  reminders: Store["reminders"] = {
    create: async (data) => {
      const r: Reminder = { ...clone(data), id: randomUUID() };
      this.reminderMap.set(r.id, r);
      return clone(r);
    },
    update: async (id, patch) => {
      const cur = this.reminderMap.get(id);
      if (!cur) throw new Error(`Reminder not found: ${id}`);
      this.reminderMap.set(id, { ...cur, ...clone(patch) });
    },
    listDue: async (now) =>
      clone([...this.reminderMap.values()].filter((r) => r.status === "pending" && r.fireAt <= now)
        .sort((a, b) => a.fireAt.localeCompare(b.fireAt))),
    listPending: async () =>
      clone([...this.reminderMap.values()].filter((r) => r.status === "pending")
        .sort((a, b) => a.fireAt.localeCompare(b.fireAt))),
  };

  conversation: Store["conversation"] = {
    append: async (t) => void this.turns.push({ ...clone(t), id: randomUUID() }),
    recent: async (n) => clone([...this.turns].sort((a, b) => a.at.localeCompare(b.at)).slice(-n)),
  };

  outbox: Store["outbox"] = {
    create: async (data) => {
      const m: OutboxMessage = { ...clone(data), id: randomUUID() };
      this.outboxMap.set(m.id, m);
      return clone(m);
    },
    update: async (id, patch) => {
      const cur = this.outboxMap.get(id);
      if (!cur) throw new Error(`Outbox message not found: ${id}`);
      this.outboxMap.set(id, { ...cur, ...clone(patch) });
    },
    listPending: async () =>
      clone([...this.outboxMap.values()].filter((m) => m.status === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))),
  };

  state: Store["state"] = {
    get: async <K extends keyof StateDocs>(key: K) => clone((this.stateMap.get(key) as StateDocs[K] | undefined) ?? null),
    set: async <K extends keyof StateDocs>(key: K, value: StateDocs[K]) => void this.stateMap.set(key, clone(value)),
  };

  settings: Store["settings"] = {
    get: async () => ({ ...DEFAULT_SETTINGS, ...clone(this.settingsOverride) }),
  };

  processed: Store["processed"] = {
    claim: async (key, at) => {
      if (this.processedMap.has(key)) return false;
      this.processedMap.set(key, at);
      return true;
    },
    purgeOlderThan: async (iso) => {
      let n = 0;
      for (const [k, at] of this.processedMap) {
        if (at < iso) {
          this.processedMap.delete(k);
          n++;
        }
      }
      return n;
    },
  };
}
