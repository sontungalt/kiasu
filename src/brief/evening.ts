import { addDaysToKey, formatSgt, sgtDateKey } from "../lib/clock.js";
import { sortItems } from "../store/filter.js";
import type { Item } from "../types.js";
import { BriefBuilder, briefTemplate, uniqueById, type BriefInput, type ComposedBrief } from "./builder.js";
import { dueDayKey, eventLine, weekdayOf } from "./format.js";

export const EMPTY_EVENING = "Nothing due tomorrow and nothing left open. Sleep well! 😴";

export function composeEvening(input: BriefInput, now: Date): ComposedBrief {
  const today = sgtDateKey(now);
  const tomorrow = addDaysToKey(today, 1);
  const since = input.sinceIso;
  const dayOf = (i: Item) => (i.dueAt ? dueDayKey(i.dueAt) : null);
  const dated = sortItems(input.openItems.filter((i) => i.dueAt !== null));
  const urgentSince = input.openItems.filter((i) =>
    (i.alertedAt !== null && i.alertedAt >= since) || (i.urgency === "urgent" && i.createdAt >= since));

  const b = new BriefBuilder(now);
  b.bullets("🗓 Tomorrow", input.events.map(eventLine));
  b.items("🗓 Due tomorrow", dated.filter((i) => dayOf(i) === tomorrow), "due");
  const stillOpen = b.items("⏳ Still open from today", dated.filter((i) => dayOf(i) === today), "due");
  b.items("🚨 Urgent since this morning", sortItems(uniqueById([...input.overnightAlerts, ...urgentSince])), "relative");

  const text = b.finish(`*Evening check-in · ${formatSgt(now, "dayDate")}* 🌙`, EMPTY_EVENING, input.health);
  const urgent = b.urgentCount;
  return {
    text,
    numbering: b.numbering,
    template: briefTemplate(`${weekdayOf(now)} evening`, stillOpen, urgent),
    counts: { dueToday: stillOpen, urgent },
  };
}
