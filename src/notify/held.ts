import type { Store } from "../store/types.js";
import type { Item } from "../types.js";

export async function heldAlertIds(store: Store): Promise<string[]> {
  return (await store.state.get("heldAlerts"))?.itemIds ?? [];
}

export async function addHeldAlerts(store: Store, ids: string[]): Promise<void> {
  const current = await heldAlertIds(store);
  await store.state.set("heldAlerts", { itemIds: [...new Set([...current, ...ids])] });
}

/** Held items that still deserve mention: open and never alerted. */
export async function loadHeldAlerts(store: Store): Promise<Item[]> {
  const ids = [...new Set(await heldAlertIds(store))];
  const items = await Promise.all(ids.map((id) => store.items.get(id)));
  return items.filter((i): i is Item => i !== null && i.status === "open" && i.alertedAt === null);
}

/** Sets alertedAt on each item and removes them from the held list. */
export async function markAlerted(store: Store, ids: string[], nowIso: string): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) await store.items.update(id, { alertedAt: nowIso });
  const current = await heldAlertIds(store);
  const remaining = current.filter((id) => !ids.includes(id));
  if (remaining.length !== current.length) await store.state.set("heldAlerts", { itemIds: remaining });
}

/** Drops held IDs whose items were closed, deleted or alerted some other way. */
export async function pruneHeldAlerts(store: Store): Promise<void> {
  const current = await heldAlertIds(store);
  if (current.length === 0) return;
  const keep = (await loadHeldAlerts(store)).map((i) => i.id);
  if (keep.length !== current.length) await store.state.set("heldAlerts", { itemIds: keep });
}
