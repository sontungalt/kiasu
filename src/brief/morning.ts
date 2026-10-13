import { addDaysToKey, formatSgt, sgtDateKey } from "../lib/clock.js";
import { sortItems } from "../store/filter.js";
import type { Item } from "../types.js";
import { BriefBuilder, briefTemplate, uniqueById, type BriefInput, type ComposedBrief } from "./builder.js";
import { dueDayKey, emailLine, eventLine, failedEmailsBlock, isPastDue, weekdayOf } from "./format.js";

export const EMPTY_MORNING = "Nothing due today and nothing new. Enjoy your day! 🎉";

export function composeMorning(input: BriefInput, now: Date): ComposedBrief {
  const today = sgtDateKey(now);
  const tomorrow = addDaysToKey(today, 1);
  const held = new Set(input.overnightAlerts.map((i) => i.id));
  const onDay = (key: string) => (i: Item) =>
    i.dueAt !== null && !isPastDue(i, now) && dueDayKey(i.dueAt) === key;
  const dated = sortItems(input.openItems.filter((i) => i.dueAt !== null && !held.has(i.id)));

  const b = new BriefBuilder(now);
  b.bullets("🗓 Today", input.events.map(eventLine));
  b.items("⚠️ Overdue", dated.filter((i) => isPastDue(i, now)), "due");
  b.items("📌 Due today", dated.filter(onDay(today)), "due");
  b.items("🗓 Due tomorrow", dated.filter(onDay(tomorrow)), "due");
  b.items("🌙 Came in overnight", sortItems(input.overnightAlerts), "relative");
  b.bullets("📬 New & important", input.importantEmails.map(emailLine));
  b.block(failedEmailsBlock(input.failedEmails));

  const text = b.finish(`*Good morning! ${formatSgt(now, "dayDate")}* ☀️`, EMPTY_MORNING, input.health);
  const dueToday = uniqueById([...input.openItems, ...input.overnightAlerts]).filter(onDay(today)).length;
  const urgent = b.urgentCount;
  return {
    text,
    numbering: b.numbering,
    template: briefTemplate(weekdayOf(now), dueToday, urgent),
    counts: { dueToday, urgent },
  };
}
