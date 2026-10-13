import type { Importance, Settings } from "../types.js";
import type { UpsertResult } from "./upsert.js";
import { HOUR_MS } from "../lib/clock.js";

export interface AlertContext {
  importance: Importance;
  senderEmail: string | null;
}

export function senderEmailOf(from: string): string | null {
  const m = from.match(/<([^>]+)>/) ?? from.match(/([^\s<>]+@[^\s<>]+)/);
  return m?.[1] ? m[1].trim().toLowerCase() : null;
}

export function isVip(email: string, vipSenders: string[]): boolean {
  const e = email.toLowerCase();
  return vipSenders.some((v) => {
    const s = v.toLowerCase();
    return s.startsWith("@") ? e.endsWith(s) : e === s;
  });
}

export function shouldAlert(result: UpsertResult, ctx: AlertContext, settings: Settings, now: Date): boolean {
  const { item, change, dueChanged } = result;
  if (item.status !== "open") return false;
  if (change === "unchanged") return false;
  if (change === "updated" && !dueChanged) return false;
  if (item.alertedAt) return false;

  const dueMs = item.dueAt ? Date.parse(item.dueAt) : null;
  const dueSoon = dueMs !== null && dueMs > now.getTime() && dueMs - now.getTime() <= settings.urgentWindowHours * HOUR_MS;

  if (item.urgency === "urgent") return true;
  if (dueSoon && ctx.importance === "high") return true;
  if (dueChanged && dueSoon) return true;
  if (ctx.senderEmail && isVip(ctx.senderEmail, settings.vipSenders) && ctx.importance !== "low") return true;
  return false;
}
