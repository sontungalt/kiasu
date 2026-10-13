import { Firestore, type DocumentData } from "@google-cloud/firestore";
import type { Store, ItemFilter } from "./types.js";
import { applyFilter } from "./filter.js";
import type {
  AccountState, ConversationTurn, EmailRecord, Item, OutboxMessage, Reminder, Settings, StateDocs,
} from "../types.js";
import { DEFAULT_SETTINGS } from "../types.js";

export function createFirestore(projectId: string): Firestore {
  return new Firestore({ projectId, ignoreUndefinedProperties: true });
}

/** Firestore doc ids cannot contain "/". */
const docId = (key: string) => key.replace(/\//g, "_");

const ALREADY_EXISTS = 6;

export class FirestoreStore implements Store {
  constructor(private db: Firestore) {}

  private col(name: string) {
    return this.db.collection(name);
  }

  private async all<T>(q: FirebaseFirestore.Query): Promise<T[]> {
    const snap = await q.get();
    return snap.docs.map((d) => ({ ...(d.data() as DocumentData), id: d.id }) as T);
  }

  private async one<T>(name: string, id: string): Promise<T | null> {
    const snap = await this.col(name).doc(docId(id)).get();
    return snap.exists ? ({ ...(snap.data() as DocumentData), id: snap.id } as T) : null;
  }

  accounts: Store["accounts"] = {
    get: (id) => this.one<AccountState>("accounts", id),
    upsert: async (a) => void (await this.col("accounts").doc(a.id).set(a)),
  };

  emails: Store["emails"] = {
    get: (id) => this.one<EmailRecord>("emails", id),
    upsert: async (e) => void (await this.col("emails").doc(docId(e.id)).set(e)),
    listPending: async (limit) =>
      (await this.all<EmailRecord>(this.col("emails").where("triageStatus", "==", "pending")))
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).slice(0, limit),
    listImportantSince: async (since) =>
      (await this.all<EmailRecord>(this.col("emails").where("processedAt", ">=", since)))
        .filter((e) => e.triageStatus === "done" && (e.importance === "high" || e.importance === "medium"))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
  };

  items: Store["items"] = {
    get: (id) => this.one<Item>("items", id),
    create: async (data) => {
      const ref = this.col("items").doc();
      await ref.set(data);
      return { ...data, id: ref.id };
    },
    update: async (id, patch) => void (await this.col("items").doc(id).update(patch as DocumentData)),
    findByDedupeKey: async (key) =>
      (await this.all<Item>(this.col("items").where("dedupeKey", "==", key).limit(1)))[0] ?? null,
    listByThread: (threadId) => this.all<Item>(this.col("items").where("source.threadId", "==", threadId)),
    list: async (filter: ItemFilter) => {
      const q = filter.status && filter.status.length > 0
        ? this.col("items").where("status", "in", filter.status)
        : this.col("items");
      return applyFilter(await this.all<Item>(q), filter);
    },
  };

  reminders: Store["reminders"] = {
    create: async (data) => {
      const ref = this.col("reminders").doc();
      await ref.set(data);
      return { ...data, id: ref.id };
    },
    update: async (id, patch) => void (await this.col("reminders").doc(id).update(patch as DocumentData)),
    listDue: async (now) =>
      (await this.reminders.listPending()).filter((r) => r.fireAt <= now),
    listPending: async () =>
      (await this.all<Reminder>(this.col("reminders").where("status", "==", "pending")))
        .sort((a, b) => a.fireAt.localeCompare(b.fireAt)),
  };

  conversation: Store["conversation"] = {
    append: async (t) => void (await this.col("conversation").add(t)),
    recent: async (n) =>
      (await this.all<ConversationTurn>(this.col("conversation").orderBy("at", "desc").limit(n))).reverse(),
  };

  outbox: Store["outbox"] = {
    create: async (data) => {
      const ref = this.col("outbox").doc();
      await ref.set(data);
      return { ...data, id: ref.id };
    },
    update: async (id, patch) => void (await this.col("outbox").doc(id).update(patch as DocumentData)),
    listPending: async () =>
      (await this.all<OutboxMessage>(this.col("outbox").where("status", "==", "pending")))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };

  state: Store["state"] = {
    get: async <K extends keyof StateDocs>(key: K) => {
      const snap = await this.col("state").doc(key).get();
      return snap.exists ? (snap.data() as StateDocs[K]) : null;
    },
    set: async <K extends keyof StateDocs>(key: K, value: StateDocs[K]) =>
      void (await this.col("state").doc(key).set(value as DocumentData)),
  };

  settings: Store["settings"] = {
    get: async () => {
      const snap = await this.col("settings").doc("main").get();
      return { ...DEFAULT_SETTINGS, ...((snap.data() as Partial<Settings> | undefined) ?? {}) };
    },
  };

  processed: Store["processed"] = {
    claim: async (key, at) => {
      try {
        await this.col("processed").doc(docId(key)).create({ at });
        return true;
      } catch (err) {
        if ((err as { code?: number }).code === ALREADY_EXISTS) return false;
        throw err;
      }
    },
    purgeOlderThan: async (iso) => {
      const snap = await this.col("processed").where("at", "<", iso).get();
      const batch = this.db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      if (!snap.empty) await batch.commit();
      return snap.size;
    },
  };
}
