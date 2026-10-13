import type { CalendarService, Deps } from "../ports.js";
import { ACCOUNT_IDS, type AccountId, type CalendarEvent } from "../types.js";
import { googleAuthFor, isInvalidGrant } from "../google/auth.js";
import { addDaysToKey, sgtAt, toUtcIso } from "../lib/clock.js";
import { googleCalendarApi, type CalendarApiFactory, type RawEvent } from "./api.js";

export type CalendarDeps = Pick<Deps, "config" | "log" | "store">;

/** Converts a Calendar event to our shape, or null if it should not be shown. */
export function mapEvent(ev: RawEvent, account: AccountId, calendarId: string): CalendarEvent | null {
  if (!ev.id || ev.status === "cancelled") return null;
  if (ev.attendees?.some((a) => a.self === true && a.responseStatus === "declined")) return null;
  let startAt: string;
  let endAt: string;
  let allDay: boolean;
  try {
    if (ev.start?.dateTime) {
      startAt = toUtcIso(ev.start.dateTime);
      endAt = ev.end?.dateTime ? toUtcIso(ev.end.dateTime) : startAt;
      allDay = false;
    } else if (ev.start?.date) {
      // All-day events are calendar days with an exclusive end. We pin them to SGT midnight.
      startAt = sgtAt(ev.start.date, "00:00").toISOString();
      endAt = sgtAt(ev.end?.date ?? addDaysToKey(ev.start.date, 1), "00:00").toISOString();
      allDay = true;
    } else {
      return null;
    }
  } catch {
    return null; // unparseable date
  }
  return {
    id: ev.id,
    account,
    calendarId,
    title: ev.summary?.trim() || "(no title)",
    startAt,
    endAt,
    allDay,
    location: ev.location?.trim() || null,
  };
}

const ACCOUNT_ORDER: Record<AccountId, number> = { personal: 0, school: 1 };

function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  return (
    a.startAt.localeCompare(b.startAt) ||
    Number(b.allDay) - Number(a.allDay) ||
    ACCOUNT_ORDER[a.account] - ACCOUNT_ORDER[b.account] ||
    a.title.localeCompare(b.title)
  );
}

/** Sorts by start and drops copies of the same event (same title + start) from another calendar or account. */
export function mergeEvents(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  const out: CalendarEvent[] = [];
  for (const e of [...events].sort(compareEvents)) {
    const key = `${e.title.trim().toLowerCase()}|${e.startAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export function createCalendarService(deps: CalendarDeps, api: CalendarApiFactory = googleCalendarApi): CalendarService {
  const log = deps.log.child({ module: "calendar" });

  async function listForAccount(account: AccountId, fromIso: string, toIso: string): Promise<CalendarEvent[]> {
    const state = await deps.store.accounts.get(account);
    if (state?.authStatus === "revoked") return [];
    const auth = googleAuthFor(account, deps.config);
    if (!auth) return [];
    const client = api(auth, account);
    const out: CalendarEvent[] = [];
    for (const calendarId of await client.listSelectedCalendarIds()) {
      try {
        for (const ev of await client.listEvents(calendarId, fromIso, toIso)) {
          const mapped = mapEvent(ev, account, calendarId);
          if (mapped) out.push(mapped);
        }
      } catch (err) {
        if (isInvalidGrant(err)) throw err; // the whole account is broken. Handled by the caller.
        log.warn("calendar: listing one calendar failed", { account, calendarId, err });
      }
    }
    return out;
  }

  return {
    async listEvents(fromIso, toIso) {
      const from = toUtcIso(fromIso);
      const to = toUtcIso(toIso);
      if (to <= from) return [];
      const perAccount = await Promise.all(
        ACCOUNT_IDS.map(async (account) => {
          try {
            return await listForAccount(account, from, to);
          } catch (err) {
            log.warn(isInvalidGrant(err) ? "calendar: invalid_grant, skipping account" : "calendar: account failed, skipping", {
              account,
              err,
            });
            return [];
          }
        }),
      );
      return mergeEvents(perAccount.flat());
    },
  };
}
