import type { CalendarEvent, EmailRecord, Item } from "../types.js";
import { addDaysToKey, formatSgt, sgtAt, sgtDateKey, sgtTimeHHMM } from "../lib/clock.js";

export const MAX_TITLE = 60;
export const MAX_SOURCE = 24;
const MAX_FAILED_LISTED = 5;
const DAY_MS = 86_400_000;

export const bold = (s: string): string => `*${s}*`;
export const italic = (s: string): string => `_${s}_`;

/** Collapses whitespace; cuts to `max` code points, ending in "…" when cut. */
export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  const cps = Array.from(t);
  if (cps.length <= max) return t;
  return `${cps.slice(0, max - 1).join("").trimEnd()}…`;
}

/** "Mr Lim <lim@x>" -> "Mr Lim"; "\"Tan, Mary\" <t@x>" -> "Tan, Mary"; "lim@x" -> "lim". */
export function senderName(from: string): string {
  const s = from.trim();
  const lt = s.indexOf("<");
  if (lt > 0) {
    const name = s.slice(0, lt).trim().replace(/^"(.*)"$/, "$1").trim();
    if (name) return name;
  }
  const address = s.match(/<([^>]+)>/)?.[1] ?? s;
  const at = address.indexOf("@");
  return at > 0 ? address.slice(0, at) : address;
}

export function sourceLabel(item: Item): string | null {
  const src = item.source;
  const label = src.kind === "email" ? senderName(src.from) : src.kind === "classroom" ? src.courseName : "";
  return label ? truncate(label, MAX_SOURCE) : null;
}

/** SGT day an item is due on. Exactly 00:00 counts as the end of the previous day. */
export function dueDayKey(dueAtIso: string): string {
  return sgtDateKey(new Date(Date.parse(dueAtIso) - 1));
}

export function dueTime(dueAtIso: string): string {
  const d = new Date(dueAtIso);
  return sgtTimeHHMM(d) === "00:00" ? "midnight" : formatSgt(d, "time");
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
}

/** "Mon" within 6 days of today, otherwise "4 Oct". */
export function shortDay(dateKey: string, todayKey: string): string {
  const [weekday = "", day = "", month = ""] = formatSgt(sgtAt(dateKey, "12:00"), "dayDate").split(" ");
  return Math.abs(dayDiff(dateKey, todayKey)) <= 6 ? weekday : `${day} ${month}`;
}

export function isPastDue(item: Pick<Item, "dueAt">, now: Date): boolean {
  return item.dueAt !== null && Date.parse(item.dueAt) <= now.getTime();
}

export function whenLabel(dueAtIso: string, now: Date): string {
  const today = sgtDateKey(now);
  const key = dueDayKey(dueAtIso);
  const time = dueTime(dueAtIso);
  if (Date.parse(dueAtIso) <= now.getTime()) return `was due ${key === today ? time : shortDay(key, today)}`;
  const day = key === today ? "today" : key === addDaysToKey(today, 1) ? "tomorrow" : shortDay(key, today);
  return `due ${day} ${time === "midnight" ? "by midnight" : time}`;
}

/** "due": the section already says which day, so show "by 3pm". "relative": show the day too. */
export type LineMode = "due" | "relative";

export function itemText(item: Item, now: Date, mode: LineMode): string {
  let text = truncate(item.title, MAX_TITLE);
  if (item.dueAt) {
    if (isPastDue(item, now)) text += ` (${whenLabel(item.dueAt, now)})`;
    else if (mode === "due") text += ` · by ${dueTime(item.dueAt)}`;
    else text += ` · ${whenLabel(item.dueAt, now)}`;
  }
  const src = sourceLabel(item);
  return src ? `${text} · ${src}` : text;
}

export const itemLine = (n: number, item: Item, now: Date, mode: LineMode): string =>
  `${n}. ${itemText(item, now, mode)}`;

export const itemBullet = (item: Item, now: Date, mode: LineMode = "due"): string =>
  `• ${itemText(item, now, mode)}`;

export function eventLine(e: CalendarEvent): string {
  const when = e.allDay
    ? "All day:"
    : `${formatSgt(new Date(e.startAt), "time")}–${formatSgt(new Date(e.endAt), "time")}`;
  const where = e.location ? ` · ${truncate(e.location, 30)}` : "";
  return `• ${when} ${truncate(e.title, MAX_TITLE)}${where}`;
}

export function emailLine(e: EmailRecord): string {
  const who = truncate(senderName(e.from), MAX_SOURCE) || "Unknown sender";
  return `• ${who}: ${truncate(e.summary ?? e.subject, 100)}`;
}

export function moreLine(hidden: number): string {
  return italic(`…and ${hidden} more. Ask me to list them.`);
}

export function failedEmailsBlock(emails: EmailRecord[]): string | null {
  const subject = (e: EmailRecord) => bold(truncate(e.subject || "(no subject)", 80));
  const [first] = emails;
  if (!first) return null;
  if (emails.length === 1) return `⚠️ 1 email couldn't be read automatically: ${subject(first)}`;
  const lines = emails.slice(0, MAX_FAILED_LISTED).map((e) => `• ${subject(e)}`);
  if (emails.length > MAX_FAILED_LISTED) lines.push(moreLine(emails.length - MAX_FAILED_LISTED));
  return [`⚠️ ${emails.length} emails couldn't be read automatically:`, ...lines].join("\n");
}

export function weekdayOf(now: Date): string {
  return formatSgt(now, "dayDate").split(" ")[0] ?? "";
}
