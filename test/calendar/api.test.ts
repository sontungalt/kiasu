import { describe, it, expect } from "vitest";
import {
  calendarApiFromClient, googleCalendarApi, type CalendarRawClient, type RawEvent,
} from "../../src/calendar/api.js";
import { googleAuthFor } from "../../src/google/auth.js";
import { loadConfig } from "../../src/config.js";
import { TEST_ENV } from "../helpers/env.js";

function rawClient(over: Partial<CalendarRawClient>): CalendarRawClient {
  const notStubbed = async (): Promise<never> => {
    throw new Error("not stubbed");
  };
  return { calendarListList: notStubbed, eventsList: notStubbed, ...over };
}

describe("calendarApiFromClient", () => {
  it("lists only selected calendars across pages", async () => {
    const params: Array<Parameters<CalendarRawClient["calendarListList"]>[0]> = [];
    const api = calendarApiFromClient(rawClient({
      calendarListList: async (p) => {
        params.push(p);
        return p.pageToken === "2"
          ? { items: [{ id: "cca@group.calendar.google.com", selected: true }], nextPageToken: null }
          : {
              items: [
                { id: "primary-id", selected: true },
                { id: "holidays", selected: false },
                { id: "unset" },
                { id: null, selected: true },
              ],
              nextPageToken: "2",
            };
      },
    }));
    expect(await api.listSelectedCalendarIds()).toEqual(["primary-id", "cca@group.calendar.google.com"]);
    expect(params.map((p) => p.pageToken)).toEqual([undefined, "2"]);
    expect(params[0]!.maxResults).toBe(250);
  });

  it("expands recurring events, orders by start time and follows pages", async () => {
    const params: Array<Parameters<CalendarRawClient["eventsList"]>[0]> = [];
    const e1: RawEvent = { id: "e1", summary: "A" };
    const e2: RawEvent = { id: "e2", summary: "B" };
    const api = calendarApiFromClient(rawClient({
      eventsList: async (p) => {
        params.push(p);
        return p.pageToken ? { items: [e2] } : { items: [e1], nextPageToken: "n" };
      },
    }));
    expect(await api.listEvents("cal1", "2026-10-13T16:00:00.000Z", "2026-10-14T16:00:00.000Z")).toEqual([e1, e2]);
    expect(params[0]).toMatchObject({
      calendarId: "cal1",
      timeMin: "2026-10-13T16:00:00.000Z",
      timeMax: "2026-10-14T16:00:00.000Z",
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    });
    expect(params[1]!.pageToken).toBe("n");
  });

  it("googleCalendarApi builds a client without touching the network", () => {
    const auth = googleAuthFor("personal", loadConfig(TEST_ENV))!;
    const api = googleCalendarApi(auth, "personal");
    expect(typeof api.listSelectedCalendarIds).toBe("function");
    expect(typeof api.listEvents).toBe("function");
  });
});
