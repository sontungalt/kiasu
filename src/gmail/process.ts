import type { Deps, SyncResult } from "../ports.js";
import type { EmailRecord, Item, ParsedEmail } from "../types.js";
import { toUtcIso } from "../lib/clock.js";
import { emailDedupeKey, upsertItem, type ItemDraft } from "../items/upsert.js";
import { senderEmailOf, shouldAlert } from "../items/alerts.js";
import { TriageRefusedError, type TriageFn, type TriageResult } from "../triage/triage.js";
import { errInfo } from "./api.js";

export const SKIP_LABELS: readonly string[] = ["SPAM", "TRASH", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"];
export const MAX_TRIAGE_ATTEMPTS = 5;

export type ProcessCtx = Pick<Deps, "clock" | "log" | "store"> & { triage: TriageFn };

export interface TriageOutcome {
  triaged: number;
  alerts: Item[];
}

/** Spec §7a: Classroom sync is the source of truth for these, so their emails create no items. */
export function isClassroomSender(from: string): boolean {
  const domain = senderEmailOf(from)?.split("@")[1] ?? "";
  return domain === "classroom.google.com" || domain.endsWith(".classroom.google.com");
}

export function newEmailRecord(parsed: ParsedEmail): EmailRecord {
  return {
    id: parsed.id,
    account: parsed.account,
    threadId: parsed.threadId,
    from: parsed.from,
    subject: parsed.subject,
    receivedAt: toUtcIso(parsed.date),
    summary: null,
    category: null,
    importance: null,
    needsReply: false,
    triageStatus: "pending",
    triageAttempts: 0,
    processedAt: null,
  };
}

/** Records a newly seen email: skipped (pre-filter) or stored pending, then triaged. */
export async function ingestParsed(ctx: ProcessCtx, parsed: ParsedEmail): Promise<SyncResult> {
  const record = newEmailRecord(parsed);
  if (parsed.labelIds.some((l) => SKIP_LABELS.includes(l))) {
    await ctx.store.emails.upsert({
      ...record,
      category: "promotion",
      importance: "low",
      triageStatus: "skipped",
      processedAt: ctx.clock.now().toISOString(),
    });
    return { fetched: 1, triaged: 0, alerts: [] };
  }
  await ctx.store.emails.upsert(record); // pending first: a crash mid-triage leaves it for retryPendingTriage
  const outcome = await triageRecord(ctx, record, parsed);
  return { fetched: 1, ...outcome };
}

export async function triageRecord(ctx: ProcessCtx, record: EmailRecord, parsed: ParsedEmail): Promise<TriageOutcome> {
  const now = ctx.clock.now();
  const nowIso = now.toISOString();
  const attempts = record.triageAttempts + 1;

  let result: TriageResult;
  try {
    result = await ctx.triage(parsed, record.account, now);
  } catch (err) {
    const refused = err instanceof TriageRefusedError;
    const final = refused || attempts >= MAX_TRIAGE_ATTEMPTS;
    await ctx.store.emails.upsert({
      ...record,
      triageAttempts: attempts,
      triageStatus: final ? "failed" : "pending",
      processedAt: final ? nowIso : null,
    });
    ctx.log.warn("triage failed", { account: record.account, emailId: record.id, attempts, refused, final, err: errInfo(err) });
    return { triaged: 0, alerts: [] };
  }

  await ctx.store.emails.upsert({
    ...record,
    summary: result.summary,
    category: result.category,
    importance: result.importance,
    needsReply: result.needsReply,
    triageStatus: "done",
    triageAttempts: attempts,
    processedAt: nowIso,
  });

  if (isClassroomSender(record.from)) {
    ctx.log.info("classroom notification: summary only", { emailId: record.id, itemsIgnored: result.items.length });
    return { triaged: 1, alerts: [] };
  }

  const settings = await ctx.store.settings.get();
  const senderEmail = senderEmailOf(record.from);
  const alerts: Item[] = [];
  for (const it of result.items) {
    const draft: ItemDraft = {
      type: it.type,
      title: it.title,
      details: it.details,
      dueAt: it.dueAt,
      startAt: it.startAt,
      endAt: it.endAt,
      urgency: it.urgency,
      urgencyReason: it.urgencyReason,
      source: { kind: "email", account: record.account, emailId: record.id, threadId: record.threadId, from: record.from },
      dedupeKey: emailDedupeKey(record.threadId, it.title),
    };
    const up = await upsertItem(ctx.store, draft, now);
    if (shouldAlert(up, { importance: result.importance, senderEmail }, settings, now) && !alerts.some((a) => a.id === up.item.id)) {
      alerts.push(up.item);
    }
  }
  return { triaged: 1, alerts };
}
