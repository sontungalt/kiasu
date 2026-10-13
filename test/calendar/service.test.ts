import { describe, it, expect } from "vitest";
import { createCalendarService } from "../../src/calendar/service.js";
import type { CalendarApiFactory, RawEvent } from "../../src/calendar/api.js";
import type { AccountId } from "../../src/types.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/log.js";
import { makeTestDeps } from "../helpers/deps.js";
import { TEST_ENV } from "../helpers/env.js";

const FROM = "2026-10-13T16:00:00.000Z"; // Wed 14 Oct 00:00 SGT
const TO = "2026-10-15T16:00:00.000Z"; // Fri 16 Oct 00:00 SGT

interface FakeAccount {
  calendars: string[];
  events: Record<string, RawEvent[]>;
  fail?: unknown;
  failCalendar?: Record<string, unknown>;
}

function fakeCalendar(accounts: Partial<Record<AccountId, FakeAccount>>) {
  const calls: Array<{ account: AccountId; calendarId: string; timeMin: string; timeMax: string }> = [];
  const factory: CalendarApiFactory = (_auth, account) => ({
    listSelectedCalendarIds: async () => {
      const a = accounts[account];
      if (a?.fail) throw a.fail;
      return a?.calendars ?? [];
    },
    listEvents: async (calendarId, timeMin, timeMax) => {
      calls.push({ account, calendarId, timeMin, timeMax });
      const failure = accounts[account]?.failCalendar?.[calendarId];
      if (failure) throw failure;
      return accounts[account]?.events[calendarId] ?? [];
    },
  });
  return { factory, calls };
}

const timed = (id: string, summary: string, start: string, end: string, extra: Partial<RawEvent> = {}): RawEvent =>
  ({ id, status: "confirmed", summary, start: { dateTime: start }, end: { dateTime: end }, ...extra });
const allDay = (id: string, summary: string, start: string, end: string): RawEvent =>
  ({ id, status: "confirmed", summary, start: { date: start }, end: { date: end } });

describe("CalendarService.listEvents", () => {
  it("merges selected calendars from both accounts, sorted by start", async () => {
    const { factory, calls } = fakeCalendar({
      personal: {
        calendars: ["me@gmail.com"],
        events: { "me@gmail.com": [timed("p1", "Piano lesson", "2026-10-14T17:00:00+08:00", "2026-10-14T18:00:00+08:00")] },
      },
      school: {
        calendars: ["me@students.school.edu.sg", "cca"],
        events: {
          "me@students.school.edu.sg": [timed("s1", "Chem test", "2026-10-14T09:00:00+08:00", "2026-10-14T10:00:00+08:00")],
          cca: [allDay("s2", "Sports Day", "2026-10-14", "2026-10-15")],
        },
      },
    });
    const events = await createCalendarService(makeTestDeps(), factory).listEvents(FROM, TO);
    expect(events.map((e) => [e.title, e.account, e.calendarId])).toEqual([
      ["Sports Day", "school", "cca"],
      ["Chem test", "school", "me@students.school.edu.sg"],
      ["Piano lesson", "personal", "me@gmail.com"],
    ]);
    expect(events[1]).toMatchObject({ startAt: "2026-10-14T01:00:00.000Z", endAt: "2026-10-14T02:00:00.000Z", allDay: false });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.timeMin === FROM && c.timeMax === TO)).toBe(true);
  });

  it("maps all-day and multi-day events to SGT midnights (end exclusive)", async () => {
    const { factory } = fakeCalendar({
      personal: {
        calendars: ["c"],
        events: {
          c: [
            allDay("camp", "CCA camp", "2026-10-14", "2026-10-17"),
            timed("t", "Dentist", "2026-10-15T02:00:00Z", "2026-10-15T03:00:00Z", { location: "  Bedok Clinic " }),
          ],
        },
      },
    });
    const [camp, dentist] = await createCalendarService(makeTestDeps(), factory).listEvents(FROM, TO);
    expect(camp).toEqual({
      id: "camp", account: "personal", calendarId: "c", title: "CCA camp",
      startAt: "2026-10-13T16:00:00.000Z", endAt: "2026-10-16T16:00:00.000Z", allDay: true, location: null,
    });
    expect(dentist).toMatchObject({ startAt: "2026-10-15T02:00:00.000Z", allDay: false, location: "Bedok Clinic" });
  });

  it("skips cancelled events and invites I declined", async () => {
    const at = (hhmm: string) => `2026-10-14T${hhmm}:00+08:00`;
    const { factory } = fakeCalendar({
      school: {
        calendars: ["c"],
        events: {
          c: [
            timed("x1", "Cancelled", at("09:00"), at("10:00"), { status: "cancelled" }),
            timed("x2", "Declined", at("10:00"), at("11:00"), { attendees: [{ self: true, responseStatus: "declined" }] }),
            timed("k1", "Someone else declined", at("11:00"), at("12:00"), {
              attendees: [{ self: true, responseStatus: "accepted" }, { responseStatus: "declined" }],
            }),
            timed("k2", "Maybe", at("12:00"), at("13:00"), {
              status: "tentative", attendees: [{ self: true, responseStatus: "tentative" }],
            }),
          ],
        },
      },
    });
    const events = await createCalendarService(makeTestDeps(), factory).listEvents(FROM, TO);
    expect(events.map((e) => e.id)).toEqual(["k1", "k2"]);
  });

  it("shows an event once when it is on both accounts' calendars", async () => {
    const start = "2026-10-14T07:30:00+08:00";
    const end = "2026-10-14T08:00:00+08:00";
    const { factory } = fakeCalendar({
      personal: { calendars: ["p"], events: { p: [timed("a", "Assembly", start, end)] } },
      school: {
        calendars: ["s"],
        events: {
          s: [
            timed("b", " assembly ", start, end),
            timed("c", "Assembly", "2026-10-15T07:30:00+08:00", "2026-10-15T08:00:00+08:00"),
          ],
        },
      },
    });
    const events = await createCalendarService(makeTestDeps(), factory).listEvents(FROM, TO);
    expect(events.map((e) => [e.id, e.account])).toEqual([["a", "personal"], ["c", "school"]]);
  });

  it("keeps the other account's events when one account fails (invalid_grant)", async () => {
    const lines: string[] = [];
    const deps = makeTestDeps({ log: createLogger({}, (l) => lines.push(l)) });
    const { factory } = fakeCalendar({
      personal: { calendars: [], events: {}, fail: { response: { data: { error: "invalid_grant" } } } },
      school: {
        calendars: ["s"],
        events: { s: [timed("s1", "Chem test", "2026-10-14T09:00:00+08:00", "2026-10-14T10:00:00+08:00")] },
      },
    });
    const events = await createCalendarService(deps, factory).listEvents(FROM, TO);
    expect(events.map((e) => e.id)).toEqual(["s1"]);
    const warnings = lines.map((l) => JSON.parse(l)).filter((l) => l.severity === "WARNING");
    expect(warnings.some((w) => w.account === "personal")).toBe(true);
  });

  it("one failing calendar does not hide the account's other calendars", async () => {
    const { factory } = fakeCalendar({
      school: {
        calendars: ["broken", "ok"],
        events: { ok: [timed("o1", "Lab", "2026-10-14T14:00:00+08:00", "2026-10-14T15:00:00+08:00")] },
        failCalendar: { broken: new Error("404 Not Found") },
      },
    });
    const events = await createCalendarService(makeTestDeps(), factory).listEvents(FROM, TO);
    expect(events.map((e) => e.id)).toEqual(["o1"]);
  });

  it("skips accounts without a refresh token or marked revoked", async () => {
    const deps = makeTestDeps({ config: loadConfig({ ...TEST_ENV, GOOGLE_REFRESH_TOKEN_SCHOOL: "" }) });
    await deps.store.accounts.upsert({
      id: "personal", email: "me@gmail.com", historyId: null, watchExpiresAt: null, lastSyncAt: null, authStatus: "revoked",
    });
    const { factory, calls } = fakeCalendar({
      personal: { calendars: ["p"], events: {} },
      school: { calendars: ["s"], events: {} },
    });
    expect(await createCalendarService(deps, factory).listEvents(FROM, TO)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("drops events without an id or a usable start and names untitled ones", async () => {
    const { factory } = fakeCalendar({
      personal: {
        calendars: ["c"],
        events: {
          c: [
            { status: "confirmed", summary: "No id", start: { dateTime: "2026-10-14T09:00:00+08:00" } },
            { id: "nostart", summary: "No start" },
            { id: "bad", summary: "Bad date", start: { dateTime: "garbage" } },
            { id: "u", start: { dateTime: "2026-10-14T09:00:00+08:00" }, end: { dateTime: "2026-10-14T09:30:00+08:00" } },
          ],
        },
      },
    });
    const events = await createCalendarService(makeTestDeps(), factory).listEvents(FROM, TO);
    expect(events).toEqual([expect.objectContaining({ id: "u", title: "(no title)" })]);
  });

  it("normalises the range to UTC and returns [] for an inverted one", async () => {
    const { factory, calls } = fakeCalendar({ personal: { calendars: ["p"], events: {} } });
    const svc = createCalendarService(makeTestDeps(), factory);
    expect(await svc.listEvents(TO, FROM)).toEqual([]);
    expect(calls).toHaveLength(0);
    await svc.listEvents("2026-10-14T00:00:00+08:00", "2026-10-15T00:00:00+08:00");
    expect(calls[0]).toMatchObject({ timeMin: "2026-10-13T16:00:00.000Z", timeMax: "2026-10-14T16:00:00.000Z" });
  });
});
