import type { Deps } from "../ports.js";
import { ACCOUNT_IDS, type Item } from "../types.js";
import { HOUR_MS } from "../lib/clock.js";
import { truncate } from "../brief/format.js";
import { sendNudges } from "./nudges.js";
import { maybeSendBrief } from "./briefs.js";

export type StepResult = "ok" | "skipped" | { error: string };
export type TickReport = Record<string, StepResult>;

const PROCESSED_TTL_MS = 7 * 24 * HOUR_MS;

async function wakeSnoozed(deps: Deps, now: Date): Promise<"ok" | "skipped"> {
  const nowIso = now.toISOString();
  const due = (await deps.store.items.list({ status: ["snoozed"] }))
    .filter((i) => i.snoozedUntil !== null && i.snoozedUntil <= nowIso);
  for (const i of due) await deps.store.items.update(i.id, { status: "open", snoozedUntil: null, updatedAt: nowIso });
  return due.length > 0 ? "ok" : "skipped";
}

async function fireReminders(deps: Deps, now: Date): Promise<"ok" | "skipped"> {
  const due = await deps.store.reminders.listDue(now.toISOString());
  if (due.length === 0) return "skipped";
  let failed = 0;
  for (const r of due) {
    try {
      await deps.outbox.deliver({
        kind: "reminder",
        text: `⏰ ${r.text}`,
        template: { name: "heads_up", params: [truncate(`Reminder: ${r.text}`, 60)] },
      });
      await deps.store.reminders.update(r.id, { status: "sent" });
    } catch (err) {
      failed += 1;
      deps.log.error("reminder failed", { reminderId: r.id, err });
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${due.length} reminders failed`);
  return "ok";
}

export async function tick(deps: Deps, now: Date = deps.clock.now()): Promise<TickReport> {
  const report: TickReport = {};
  const log = deps.log.child({ tickAt: now.toISOString() });

  const step = async (name: string, fn: () => Promise<"ok" | "skipped" | void>): Promise<void> => {
    try {
      const result = await fn();
      report[name] = result === "skipped" ? "skipped" : "ok";
    } catch (err) {
      report[name] = { error: err instanceof Error ? err.message : String(err) };
      log.error("tick step failed", { step: name, err });
    }
  };

  const alerts: Item[] = [];
  for (const account of ACCOUNT_IDS) {
    await step(`sync:${account}`, async () => {
      alerts.push(...(await deps.mail.syncAccount(account)).alerts);
    });
  }
  await step("retryTriage", async () => {
    alerts.push(...(await deps.mail.retryPendingTriage()).alerts);
  });
  await step("classroom", async () => {
    alerts.push(...(await deps.classroom.syncIfDue()).alerts);
  });
  await step("alerts", async () => {
    if (alerts.length === 0) return "skipped";
    await deps.notifier.sendAlerts(alerts);
  });
  await step("wakeSnoozed", () => wakeSnoozed(deps, now));
  await step("reminders", () => fireReminders(deps, now));
  await step("nudges", () => sendNudges(deps, now));
  await step("brief:morning", () => maybeSendBrief(deps, "morning", now));
  await step("brief:evening", () => maybeSendBrief(deps, "evening", now));
  await step("outboxFlush", async () => {
    await deps.outbox.flush();
  });
  for (const account of ACCOUNT_IDS) {
    await step(`watch:${account}`, () => deps.mail.renewWatchIfNeeded(account));
  }
  await step("purge", async () => {
    await deps.store.processed.purgeOlderThan(new Date(now.getTime() - PROCESSED_TTL_MS).toISOString());
  });

  log.info("tick done", { report });
  return report;
}
