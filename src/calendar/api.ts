import { google } from "googleapis";
import type { GoogleAuth } from "../google/auth.js";
import { collectPages } from "../google/collect-pages.js";
import type { AccountId } from "../types.js";

/** Subset of calendar_v3.Schema$EventDateTime. */
export interface RawEventDateTime {
  date?: string | null; // "yyyy-mm-dd" for all-day events (end is exclusive)
  dateTime?: string | null; // RFC3339 with offset for timed events
  timeZone?: string | null;
}

/** Subset of calendar_v3.Schema$Event that this app reads. Every field is nullable, as in googleapis. */
export interface RawEvent {
  id?: string | null;
  status?: string | null; // "confirmed" | "tentative" | "cancelled"
  summary?: string | null;
  location?: string | null;
  start?: RawEventDateTime | null;
  end?: RawEventDateTime | null;
  attendees?: Array<{ self?: boolean | null; responseStatus?: string | null }> | null;
}

export interface RawCalendarListEntry {
  id?: string | null;
  selected?: boolean | null;
}

/** The two googleapis calls we use, typed structurally so tests can fake them. */
export interface CalendarRawClient {
  calendarListList(params: { maxResults: number; pageToken?: string }): Promise<{
    items?: RawCalendarListEntry[] | null;
    nextPageToken?: string | null;
  }>;
  eventsList(params: {
    calendarId: string;
    timeMin: string;
    timeMax: string;
    singleEvents: boolean;
    orderBy: string;
    maxResults: number;
    pageToken?: string;
  }): Promise<{ items?: RawEvent[] | null; nextPageToken?: string | null }>;
}

export interface CalendarApi {
  /** IDs of calendars shown in my Calendar UI (calendarList entry `selected === true`). */
  listSelectedCalendarIds(): Promise<string[]>;
  /** Single (expanded) events overlapping [timeMin, timeMax), ordered by start, all pages. */
  listEvents(calendarId: string, timeMin: string, timeMax: string): Promise<RawEvent[]>;
}

export type CalendarApiFactory = (auth: GoogleAuth, account: AccountId) => CalendarApi;

const PAGE_SIZE = 250;

export function calendarApiFromClient(raw: CalendarRawClient): CalendarApi {
  return {
    async listSelectedCalendarIds() {
      const entries = await collectPages(async (pageToken) => {
        const res = await raw.calendarListList({ maxResults: PAGE_SIZE, pageToken });
        return { items: res.items ?? [], nextPageToken: res.nextPageToken };
      });
      return entries.filter((e) => e.selected === true && !!e.id).map((e) => e.id as string);
    },
    async listEvents(calendarId, timeMin, timeMax) {
      return collectPages(async (pageToken) => {
        const res = await raw.eventsList({
          calendarId, timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: PAGE_SIZE, pageToken,
        });
        return { items: res.items ?? [], nextPageToken: res.nextPageToken };
      });
    },
  };
}

export const googleCalendarApi: CalendarApiFactory = (auth) => {
  const cal = google.calendar({ version: "v3", auth });
  return calendarApiFromClient({
    calendarListList: async (params) => (await cal.calendarList.list(params)).data,
    eventsList: async (params) => (await cal.events.list(params)).data,
  });
};
