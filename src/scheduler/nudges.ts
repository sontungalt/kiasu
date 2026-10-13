import type { Deps } from "../ports.js";
import type { Item, TemplateRef } from "../types.js";
import { HOUR_MS, isQuietTime } from "../lib/clock.js";
import { dueTime, itemBullet, truncate } from "../brief/format.js";

const SUMMARY_MAX = 60;

export function composeNudge(items: Item[], now: Date, leadHours: number): { text: string; template: TemplateRef } {
  const text = ["⏳ *Due soon*", ...items.map((i) => itemBullet(i, now))].join("\n");
  const [first] = items;
  const summary = items.length === 1 && first?.dueAt
    ? `${truncate(first.title, 45)}, due ${dueTime(first.dueAt)}`
    : `${items.length} things due in the next ${leadHours}h`;
  return { text, template: { name: "heads_up", params: [truncate(summary, SUMMARY_MAX)] } };
}

export async function sendNudges(deps: Pick<Deps, "store" | "outbox" | "log">, now: Date): Promise<"ok" | "skipped"> {
  const { store } = deps;
  const settings = await store.settings.get();
  if (isQuietTime(now, settings.quietStart, settings.quietEnd)) return "skipped";

  const nowIso = now.toISOString();
  const leadMs = settings.nudgeLeadHours * HOUR_MS;
  const candidates = (await store.items.list({
    status: ["open"],
    dueAfter: nowIso,
    dueBefore: new Date(now.getTime() + leadMs + 1).toISOString(), // dueBefore is exclusive; include exactly +lead
  })).filter((i) => i.nudgedAt === null && i.dueAt !== null && i.dueAt > nowIso);
  if (candidates.length === 0) return "skipped";

  const alertedRecently = (i: Item) => i.alertedAt !== null && Date.parse(i.alertedAt) >= now.getTime() - leadMs;
  const toNudge = candidates.filter((i) => !alertedRecently(i));
  if (toNudge.length > 0) {
    const nudge = composeNudge(toNudge, now, settings.nudgeLeadHours);
    await deps.outbox.deliver({ kind: "nudge", text: nudge.text, template: nudge.template });
  }
  for (const i of candidates) await store.items.update(i.id, { nudgedAt: nowIso });
  deps.log.info("nudges", { sent: toNudge.length, recorded: candidates.length });
  return toNudge.length > 0 ? "ok" : "skipped";
}
