import type { Item } from "../types.js";
import type { ItemFilter } from "./types.js";

export function itemAccount(item: Item): string | null {
  if (item.source.kind === "email") return item.source.account;
  if (item.source.kind === "classroom") return "school";
  return null;
}

export function matchesFilter(item: Item, f: ItemFilter): boolean {
  if (f.status && !f.status.includes(item.status)) return false;
  if (f.hasDue === true && !item.dueAt) return false;
  if (f.hasDue === false && item.dueAt) return false;
  if (f.dueBefore && !(item.dueAt && item.dueAt < f.dueBefore)) return false;
  if (f.dueAfter && !(item.dueAt && item.dueAt >= f.dueAfter)) return false;
  if (f.account && itemAccount(item) !== f.account) return false;
  if (f.sourceKind && item.source.kind !== f.sourceKind) return false;
  if (f.query) {
    const q = f.query.toLowerCase();
    if (!`${item.title} ${item.details ?? ""}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

/** Due items first (soonest first), then undated by createdAt. */
export function sortItems(items: Item[]): Item[] {
  return [...items].sort((a, b) => {
    if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export function applyFilter(items: Item[], f: ItemFilter): Item[] {
  const out = sortItems(items.filter((i) => matchesFilter(i, f)));
  return f.limit ? out.slice(0, f.limit) : out;
}
