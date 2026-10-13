import type { Deps } from "../ports.js";
import type { Store } from "../store/types.js";
import { ACCOUNT_IDS, type AccountId, type CalendarEvent } from "../types.js";
import { HOUR_MS, addDaysToKey, formatSgt, sgtAt, sgtDateKey } from "../lib/clock.js";
import { loadHeldAlerts } from "../notify/held.js";
import type { BriefInput } from "./builder.js";

export type BriefKind = "morning" | "evening";

export const STALE_SYNC_MS = 2 * HOUR_MS;
export const STUCK_OUTBOX_ATTEMPTS = 3;
export const CALENDAR_DOWN = "⚠️ Couldn't load your calendar just now.";

const ACCOUNT_LABEL: Record<AccountId, string> = { personal: "Personal", school: "School" };

export async function gatherBriefInput(
  deps: Pick<Deps, "store" | "calendar" | "log">,
  kind: BriefKind,
  now: Date,
): Promise<BriefInput> {
  const { store } = deps;
  const settings = await store.settings.get();
  const today = sgtDateKey(now);
  const sinceIso = sgtAt(kind === "morning" ? addDaysToKey(today, -1) : today, settings.morningAt).toISOString();
  const day = kind === "morning" ? today : addDaysToKey(today, 1);

  const [openItems, importantEmails, failedEmails, overnightAlerts, health] = await Promise.all([
    store.items.list({ status: ["open"] }),
    store.emails.listImportantSince(sinceIso),
    store.emails.listFailedSince(sinceIso),
    loadHeldAlerts(store),
    healthLines(store, now),
  ]);

  let events: CalendarEvent[] = [];
  try {
    events = await deps.calendar.listEvents(
      sgtAt(day, "00:00").toISOString(),
      sgtAt(addDaysToKey(day, 1), "00:00").toISOString(),
    );
  } catch (err) {
    deps.log.warn("brief: calendar unavailable", { err, kind });
    health.push(CALENDAR_DOWN);
  }

  return { openItems, events, importantEmails, failedEmails, overnightAlerts, health, sinceIso };
}

export async function healthLines(store: Store, now: Date): Promise<string[]> {
  const lines: string[] = [];
  for (const id of ACCOUNT_IDS) {
    const acc = await store.accounts.get(id);
    if (!acc) continue;
    const label = ACCOUNT_LABEL[id];
    if (acc.authStatus === "revoked") {
      lines.push(`⚠️ ${label} account disconnected. Run \`npm run auth -- ${id}\` to reconnect.`);
    } else if (!acc.lastSyncAt) {
      lines.push(`⚠️ ${label} inbox hasn't synced yet. Reply "status" for details.`);
    } else if (now.getTime() - Date.parse(acc.lastSyncAt) > STALE_SYNC_MS) {
      const at = new Date(acc.lastSyncAt);
      const when = sgtDateKey(at) === sgtDateKey(now) ? formatSgt(at, "time") : formatSgt(at, "dayDateTime");
      lines.push(`⚠️ ${label} inbox not synced since ${when}. Reply "status" for details.`);
    }
  }
  const stuck = (await store.outbox.listPending())
    .filter((m) => m.lastError !== null && m.attempts >= STUCK_OUTBOX_ATTEMPTS).length;
  if (stuck > 0) {
    lines.push(`⚠️ ${stuck} WhatsApp ${stuck === 1 ? "message" : "messages"} couldn't be sent. Reply "status" for details.`);
  }
  return lines;
}
