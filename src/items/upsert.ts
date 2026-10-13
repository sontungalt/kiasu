import type { Store } from "../store/types.js";
import type { Item, ItemSource, ItemType, Urgency } from "../types.js";
import { toUtcIso } from "../lib/clock.js";

export interface ItemDraft {
  type: ItemType;
  title: string;
  details: string | null;
  dueAt: string | null;
  startAt: string | null;
  endAt: string | null;
  urgency: Urgency;
  urgencyReason: string | null;
  source: ItemSource;
  dedupeKey: string;
}

export interface UpsertResult {
  item: Item;
  change: "created" | "updated" | "unchanged";
  dueChanged: boolean;
}

const URGENCY_RANK: Record<Urgency, number> = { low: 0, normal: 1, urgent: 2 };
const STOPWORDS = new Set(["the", "a", "an", "to", "for", "of", "your", "my", "by", "on", "please", "tomorrow", "today"]);

export function normaliseTitle(title: string): string {
  let t = title.toLowerCase().trim();
  // strip repeated "re:", "fwd:", "fw:", "reminder:" prefixes
  for (;;) {
    const next = t.replace(/^(re|fwd?|reminder)\s*:\s*/, "");
    if (next === t) break;
    t = next;
  }
  return t.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function emailDedupeKey(threadId: string, title: string): string {
  return `${threadId}:${normaliseTitle(title)}`;
}

function tokens(title: string): Set<string> {
  return new Set(normaliseTitle(title).split(" ").filter((w) => w && !STOPWORDS.has(w)));
}

function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

const iso = (v: string | null) => (v ? toUtcIso(v) : null);

async function findExisting(store: Store, draft: ItemDraft, dueAt: string | null): Promise<Item | null> {
  const byKey = await store.items.findByDedupeKey(draft.dedupeKey);
  if (byKey) return byKey;
  if (draft.source.kind !== "email") return null;
  const siblings = await store.items.listByThread(draft.source.threadId);
  return (
    siblings.find((s) => s.type === draft.type && similarity(s.title, draft.title) >= 0.6) ??
    siblings.find((s) => s.type === draft.type && dueAt !== null && s.dueAt === dueAt) ??
    null
  );
}

export async function upsertItem(store: Store, draft: ItemDraft, now: Date): Promise<UpsertResult> {
  const nowIso = now.toISOString();
  const dueAt = iso(draft.dueAt);
  const startAt = iso(draft.startAt);
  const endAt = iso(draft.endAt);
  const existing = await findExisting(store, draft, dueAt);

  if (!existing) {
    const item = await store.items.create({
      type: draft.type, title: draft.title, details: draft.details,
      dueAt, startAt, endAt, urgency: draft.urgency, urgencyReason: draft.urgencyReason,
      status: "open", snoozedUntil: null, nudgedAt: null, alertedAt: null,
      source: draft.source, dedupeKey: draft.dedupeKey, createdAt: nowIso, updatedAt: nowIso,
    });
    return { item, change: "created", dueChanged: false };
  }

  const patch: Partial<Item> = {};
  const dueChanged = dueAt !== null && dueAt !== existing.dueAt;
  if (dueChanged) {
    patch.dueAt = dueAt;
    patch.alertedAt = null;
    patch.nudgedAt = null;
  }
  if (startAt !== null && startAt !== existing.startAt) patch.startAt = startAt;
  if (endAt !== null && endAt !== existing.endAt) patch.endAt = endAt;
  if (draft.details && draft.details !== existing.details) patch.details = draft.details;
  if (URGENCY_RANK[draft.urgency] > URGENCY_RANK[existing.urgency]) {
    patch.urgency = draft.urgency;
    patch.urgencyReason = draft.urgencyReason;
  }

  if (Object.keys(patch).length === 0) return { item: existing, change: "unchanged", dueChanged: false };
  patch.updatedAt = nowIso;
  await store.items.update(existing.id, patch);
  return { item: { ...existing, ...patch }, change: "updated", dueChanged };
}
