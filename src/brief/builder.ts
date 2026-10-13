import type { CalendarEvent, EmailRecord, Item, TemplateRef } from "../types.js";
import { bold, itemLine, moreLine, type LineMode } from "./format.js";

export interface BriefInput {
  openItems: Item[];
  events: CalendarEvent[];
  importantEmails: EmailRecord[];
  failedEmails: EmailRecord[];
  overnightAlerts: Item[];
  health: string[];
  /** Start of the "new since" window, UTC ISO: the last morning brief's scheduled time. */
  sinceIso: string;
}

export interface ComposedBrief {
  text: string;
  numbering: Record<string, string>;
  template: TemplateRef;
  counts: { dueToday: number; urgent: number };
}

export const MAX_ITEMS_PER_SECTION = 8;
export const MAX_BULLETS_PER_SECTION = 8;
export const FOOTER = `_Reply "done 2", "snooze 3 to tomorrow", or ask me anything._`;

export function uniqueById(items: Item[]): Item[] {
  const seen = new Map<string, Item>();
  for (const i of items) if (!seen.has(i.id)) seen.set(i.id, i);
  return [...seen.values()];
}

export function briefTemplate(label: string, dueToday: number, urgent: number): TemplateRef {
  return { name: "brief_ready", params: [label, String(dueToday), String(urgent)] };
}

/** Collects sections, numbers items continuously, and never lists an item twice. */
export class BriefBuilder {
  readonly numbering: Record<string, string> = {};
  private readonly blocks: string[] = [];
  private readonly listed = new Map<string, Item>();
  private n = 0;

  constructor(private readonly now: Date) {}

  /**
   * Numbered section. Items already listed earlier are skipped. At most MAX_ITEMS_PER_SECTION
   * lines are shown, then a "…and N more" line. Returns how many items the section covers
   * (including hidden ones). Empty sections are omitted.
   */
  items(heading: string, items: Item[], mode: LineMode): number {
    const fresh = items.filter((i) => !this.listed.has(i.id));
    if (fresh.length === 0) return 0;
    for (const i of fresh) this.listed.set(i.id, i);
    const lines = fresh.slice(0, MAX_ITEMS_PER_SECTION).map((i) => {
      this.n += 1;
      this.numbering[String(this.n)] = i.id;
      return itemLine(this.n, i, this.now, mode);
    });
    if (fresh.length > MAX_ITEMS_PER_SECTION) lines.push(moreLine(fresh.length - MAX_ITEMS_PER_SECTION));
    this.blocks.push([bold(heading), ...lines].join("\n"));
    return fresh.length;
  }

  /** Bulleted section (events, emails). Omitted when empty. */
  bullets(heading: string, lines: string[]): void {
    if (lines.length === 0) return;
    const shown = lines.slice(0, MAX_BULLETS_PER_SECTION);
    if (lines.length > shown.length) shown.push(moreLine(lines.length - shown.length));
    this.blocks.push([bold(heading), ...shown].join("\n"));
  }

  /** Free-form block without a heading. Ignored when null. */
  block(text: string | null): void {
    if (text) this.blocks.push(text);
  }

  get urgentCount(): number {
    return [...this.listed.values()].filter((i) => i.urgency === "urgent").length;
  }

  finish(header: string, emptyLine: string, health: string[]): string {
    const parts = [header, ...(this.blocks.length === 0 ? [emptyLine] : this.blocks)];
    if (health.length > 0) parts.push(health.join("\n"));
    if (this.n > 0) parts.push(FOOTER);
    return parts.join("\n\n");
  }
}
