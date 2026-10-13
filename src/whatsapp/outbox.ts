import type { Deps, OutboundMessage, Outbox } from "../ports.js";
import type { OutboxMessage, TemplateRef } from "../types.js";
import { isWindowClosedError } from "./client.js";
import { isWindowOpen } from "./window.js";

/** A message whose free-text send has failed this many times is marked "failed". */
export const MAX_SEND_ATTEMPTS = 5;
/** At most one "you have messages waiting" template per 10-minute clock bucket. */
export const TEMPLATE_GAP_MS = 10 * 60_000;
/** A send claim is valid for its 10-minute bucket, so a claim left by a crashed instance expires. */
export const SEND_CLAIM_MS = 10 * 60_000;
/** Prefix of `lastError` when the notification template for a queued message failed (flush() retries it). */
export const TEMPLATE_FAILED = "template:";

type FlushStop = "drained" | "window_closed" | "reengagement" | "send_failed" | "busy";
type NotifyResult = "sent" | "suppressed" | "failed";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface OutboxOptions {
  /**
   * The messenger has no 24h window (Telegram): free text can always be sent, and templates are never
   * sent. Failed sends stay pending and are retried by flush(), as before.
   */
  alwaysOpen?: boolean;
}

export function createOutbox(deps: Pick<Deps, "clock" | "log" | "store" | "whatsapp">, opts: OutboxOptions = {}): Outbox {
  const { clock, log, store, whatsapp } = deps;
  const alwaysOpen = opts.alwaysOpen === true;
  let tail: Promise<unknown> = Promise.resolve();
  let lastCreatedMs = 0;

  /** Runs `fn` after every earlier deliver/flush in this process has finished. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  }

  /** Strictly increasing createdAt, so messages created in the same millisecond keep their order. */
  function nextCreatedAt(): string {
    lastCreatedMs = Math.max(clock.now().getTime(), lastCreatedMs + 1);
    return new Date(lastCreatedMs).toISOString();
  }

  async function windowOpen(): Promise<boolean> {
    if (alwaysOpen) return true;
    const s = await store.state.get("whatsapp");
    return isWindowOpen(s?.lastInboundAt ?? null, clock.now());
  }

  /** Atomic, cross-instance: only one flusher may send attempt N of a message within a 10-minute bucket. */
  async function claimSend(m: OutboxMessage): Promise<boolean> {
    const now = clock.now();
    const bucket = Math.floor(now.getTime() / SEND_CLAIM_MS);
    return store.processed.claim(`wa:out:${m.id}:${m.attempts}:${bucket}`, now.toISOString());
  }

  /** Sends pending messages oldest-first while the window is open. Stops at the first problem. */
  async function sendPending(): Promise<{ sent: Set<string>; stop: FlushStop }> {
    const sent = new Set<string>();
    if (!(await windowOpen())) return { sent, stop: "window_closed" };
    for (const m of await store.outbox.listPending()) {
      if (!(await claimSend(m))) {
        log.warn("outbox: message is being sent by another flush", { outboxId: m.id });
        return { sent, stop: "busy" };
      }
      try {
        await whatsapp.sendText(m.text);
      } catch (err) {
        const attempts = m.attempts + 1;
        const reengagement = isWindowClosedError(err);
        const failed = !reengagement && attempts >= MAX_SEND_ATTEMPTS;
        await store.outbox.update(m.id, { attempts, lastError: errorText(err), status: failed ? "failed" : "pending" });
        log.error(failed ? "outbox: giving up on message" : "outbox: send failed", { outboxId: m.id, kind: m.kind, attempts, err });
        return { sent, stop: reengagement ? "reengagement" : "send_failed" };
      }
      await store.outbox.update(m.id, { status: "sent", sentAt: clock.now().toISOString(), lastError: null });
      sent.add(m.id);
    }
    return { sent, stop: "drained" };
  }

  /** Sends `template` unless one already went out in this bucket. On failure, flags `outboxId` for retry. */
  async function notify(template: TemplateRef, outboxId: string): Promise<NotifyResult> {
    if (alwaysOpen) return "suppressed";
    const now = clock.now();
    const bucket = Math.floor(now.getTime() / TEMPLATE_GAP_MS);
    if (!(await store.processed.claim(`wa:tpl:${bucket}`, now.toISOString()))) {
      log.info("outbox: template suppressed, one was sent recently", { outboxId });
      return "suppressed";
    }
    try {
      await whatsapp.sendTemplate(template);
      log.info("outbox: template sent", { outboxId, template: template.name });
      return "sent";
    } catch (err) {
      log.error("outbox: template send failed", { outboxId, template: template.name, err });
      await store.outbox.update(outboxId, { lastError: `${TEMPLATE_FAILED} ${errorText(err)}` });
      return "failed";
    }
  }

  /** Window closed: if a pending message's notification template failed earlier, try once more. */
  async function retryFailedTemplate(): Promise<void> {
    const flagged = (await store.outbox.listPending()).filter((m) => m.lastError?.startsWith(TEMPLATE_FAILED));
    const latest = flagged.at(-1);
    if (!latest?.template) return;
    if ((await notify(latest.template, latest.id)) === "sent") {
      for (const m of flagged) await store.outbox.update(m.id, { lastError: null });
    }
  }

  /** Meta reported the window closed mid-flush: tell me with the newest pending message's template. */
  async function notifyLatestPending(): Promise<void> {
    const latest = (await store.outbox.listPending()).filter((m) => m.template).at(-1);
    if (latest?.template) await notify(latest.template, latest.id);
  }

  return {
    deliver: (msg: OutboundMessage) =>
      serial(async () => {
        // Always queue first, then flush: older pending messages go out before this one.
        const rec = await store.outbox.create({
          kind: msg.kind, text: msg.text, template: msg.template,
          status: "pending", attempts: 0, lastError: null, createdAt: nextCreatedAt(), sentAt: null,
        });
        const { sent, stop } = await sendPending();
        if (sent.has(rec.id)) return "sent";
        if (stop === "window_closed" || stop === "reengagement") await notify(msg.template, rec.id);
        return "queued";
      }),

    flush: () =>
      serial(async () => {
        const { sent, stop } = await sendPending();
        if (stop === "reengagement") await notifyLatestPending();
        else if (stop === "window_closed") await retryFailedTemplate();
        return sent.size;
      }),
  };
}
