import { formatSgt, HOUR_MS } from "../lib/clock.js";
import type { Item } from "../types.js";

const SGT_OFFSET_MS = 8 * HOUR_MS;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

/** "2026-10-14T08:00:00+08:00" — the SGT wall-clock time with an explicit offset. */
export function sgtIso(d: Date): string {
  return new Date(d.getTime() + SGT_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, "+08:00");
}

/**
 * Parses a time the model passed to a tool. An ISO string without an offset is read as
 * Singapore time (never as the server's local zone, which is UTC on Cloud Run).
 * A bare date ("2026-10-17") means 23:59 SGT that day. Returns null when unparseable.
 */
export function parseToolTime(input: string): Date | null {
  const s = input.trim();
  let candidate = s;
  if (!HAS_OFFSET.test(s)) {
    if (!ISO_LOCAL.test(s)) return null;
    candidate = s.length === 10 ? `${s}T23:59:00+08:00` : `${s}+08:00`;
  }
  const d = new Date(candidate);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Open items, plus snoozed items whose snooze has run out. */
export function isActive(item: Item, now: Date): boolean {
  if (item.status === "open") return true;
  return item.status === "snoozed" && (item.snoozedUntil === null || item.snoozedUntil <= now.toISOString());
}

function sourceLabel(item: Item): string | null {
  const s = item.source;
  if (s.kind === "email") return `${s.account} email from ${s.from}`;
  if (s.kind === "classroom") return `Classroom: ${s.courseName}`;
  return "added by you";
}

/** One compact line describing an item, for tool results and the turn context. */
export function describeItem(item: Item): string {
  const parts: string[] = [item.title];
  if (item.dueAt) parts.push(`due ${formatSgt(new Date(item.dueAt), "dayDateTime")}`);
  else if (item.startAt) parts.push(`starts ${formatSgt(new Date(item.startAt), "dayDateTime")}`);
  if (item.urgency === "urgent") parts.push("URGENT");
  if (item.status !== "open") {
    parts.push(item.status === "snoozed" && item.snoozedUntil
      ? `snoozed until ${formatSgt(new Date(item.snoozedUntil), "dayDateTime")}`
      : item.status);
  }
  const src = sourceLabel(item);
  if (src) parts.push(src);
  parts.push(`id=${item.id}`);
  return parts.join(" · ");
}
