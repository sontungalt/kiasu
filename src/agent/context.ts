import type { Deps } from "../ports.js";
import type { Item } from "../types.js";
import { formatSgt } from "../lib/clock.js";
import { describeItem, isActive, sgtIso } from "./format.js";

export const CONTEXT_ITEM_CAP = 30;

/**
 * The volatile per-turn facts, sent as the LAST message with role "system" so the cached
 * prefix (tools, SYSTEM_PROMPT, earlier turns) stays byte-identical.
 */
export async function buildTurnContext(deps: Pick<Deps, "store">, now: Date): Promise<string> {
  const [lastList, candidates] = await Promise.all([
    deps.store.state.get("lastList"),
    deps.store.items.list({ status: ["open", "snoozed"] }),
  ]);
  const active = candidates.filter((i) => isActive(i, now));
  const stillSnoozed = candidates.length - active.length;

  const numberOf = new Map<string, string>();
  for (const [num, id] of Object.entries(lastList?.map ?? {})) numberOf.set(id, num);

  const lines: string[] = [
    "App context for this turn (written by the app, not by the user):",
    `Now: ${formatSgt(now, "dayDateTime")} SGT (${sgtIso(now)})`,
    "",
  ];

  const entries = Object.entries(lastList?.map ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (lastList && entries.length > 0) {
    const byId = new Map<string, Item>(candidates.map((i) => [i.id, i]));
    lines.push(`Current list numbering (last list shown to the user, ${formatSgt(new Date(lastList.at), "dayDateTime")}):`);
    for (const [num, id] of entries) {
      const item = byId.get(id) ?? (await deps.store.items.get(id));
      lines.push(item ? `${num}. ${describeItem(item)}` : `${num}. (item no longer exists) id=${id}`);
    }
  } else {
    lines.push("Current list numbering: none yet. Call list_items before acting on a number.");
  }
  lines.push("");

  const shown = active.slice(0, CONTEXT_ITEM_CAP);
  const more = active.length - shown.length;
  lines.push(`Open items (${active.length}, soonest due first${more > 0 ? `, first ${shown.length} shown` : ""}):`);
  if (shown.length === 0) lines.push("(none)");
  for (const item of shown) {
    const num = numberOf.get(item.id);
    lines.push(`- ${num ? `[#${num}] ` : ""}${describeItem(item)}`);
  }
  if (stillSnoozed > 0) lines.push(`Snoozed and hidden for now: ${stillSnoozed}`);
  return lines.join("\n");
}
