import { EMPTY_SYNC } from "../../src/ports.js";
import type { CalendarService, ClassroomService, Deps, MailService, OutboundMessage, Outbox } from "../../src/ports.js";
import type { CalendarEvent } from "../../src/types.js";
import { createNotifier } from "../../src/notify/notifier.js";
import { makeTestDeps } from "./deps.js";

export type RecordingOutbox = Outbox & { sent: OutboundMessage[]; flushes: number };

/** Outbox that "sends" everything immediately and records it. */
export function recordingOutbox(): RecordingOutbox {
  const o: RecordingOutbox = {
    sent: [],
    flushes: 0,
    async deliver(msg) {
      o.sent.push(msg);
      return "sent";
    },
    async flush() {
      o.flushes += 1;
      return 0;
    },
  };
  return o;
}

/** Mail service whose sync/retry/watch calls succeed with nothing to do. Override per test. */
export function fakeMail(over: Partial<MailService> = {}): MailService {
  const unexpected = (m: string) => async () => {
    throw new Error(`mail.${m} unexpected in scheduler tests`);
  };
  return {
    handlePush: unexpected("handlePush"),
    search: unexpected("search"),
    read: unexpected("read"),
    syncAccount: async () => EMPTY_SYNC,
    retryPendingTriage: async () => EMPTY_SYNC,
    renewWatchIfNeeded: async () => {},
    ...over,
  };
}

export function fakeCalendar(events: CalendarEvent[] = []): CalendarService & { calls: Array<[string, string]> } {
  const cal = {
    calls: [] as Array<[string, string]>,
    async listEvents(fromIso: string, toIso: string) {
      cal.calls.push([fromIso, toIso]);
      return events;
    },
  };
  return cal;
}

export function fakeClassroom(over: Partial<ClassroomService> = {}): ClassroomService {
  return { syncIfDue: async () => EMPTY_SYNC, sync: async () => EMPTY_SYNC, ...over };
}

/** Test deps with working fakes for every service the scheduler touches, the clock at `nowIso`, and a real Notifier. */
export function makeSchedulerDeps(nowIso: string, over: Partial<Deps> = {}) {
  const outbox = recordingOutbox();
  const deps = makeTestDeps({
    mail: fakeMail(), calendar: fakeCalendar(), classroom: fakeClassroom(), outbox, ...over,
  });
  deps.clock.set(nowIso);
  deps.notifier = createNotifier(deps);
  return { deps, outbox };
}
