import type { CalendarEvent, EmailRecord, Item, ItemSource } from "../../src/types.js";
import { makeItem } from "../store/contract.js";

/** Wed 14 Oct 2026, 06:30 SGT. */
export const MORNING = new Date("2026-10-13T22:30:00.000Z");
/** Wed 14 Oct 2026, 21:00 SGT. */
export const EVENING = new Date("2026-10-14T13:00:00.000Z");

export const emailSource = (from: string): ItemSource =>
  ({ kind: "email", account: "school", emailId: `m-${from.length}`, threadId: `t-${from.length}`, from });

export const classroomSource = (courseName: string): ItemSource =>
  ({ kind: "classroom", courseId: "c1", courseName, courseWorkId: "cw1", announcementId: null, link: null });

export const MANUAL: ItemSource = { kind: "manual" };

export function item(id: string, over: Partial<Omit<Item, "id">> = {}): Item {
  return { ...makeItem({ dedupeKey: `key:${id}`, ...over }), id };
}

export function email(id: string, over: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id, account: "school", threadId: `t-${id}`, from: "Mrs Tan <tan@school.edu.sg>", subject: "Test moved",
    receivedAt: "2026-10-13T12:00:00.000Z", summary: "Thursday's test moved to Friday", category: "teacher_message",
    importance: "high", needsReply: false, triageStatus: "done", triageAttempts: 1,
    processedAt: "2026-10-13T12:00:05.000Z",
    ...over,
  };
}

export function event(id: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, account: "school", calendarId: "primary", title: "Assembly",
    startAt: "2026-10-13T23:30:00.000Z", endAt: "2026-10-14T00:00:00.000Z", allDay: false, location: null,
    ...over,
  };
}
