import { describe, it, expect, beforeEach } from "vitest";
import { createClassroomService } from "../../src/classroom/service.js";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import { FakeClassroomApi, announcement, courseWork } from "./fakes.js";
import { fakeAnthropic, jsonReply, type FakeReply } from "./fake-anthropic.js";

// makeTestDeps clock: 2026-10-14T00:00:00Z = Wed 14 Oct 08:00 SGT
let deps: TestDeps;
let fake: FakeClassroomApi;
let ai: ReturnType<typeof fakeAnthropic>;

function withModel(reply: (body: Record<string, any>) => FakeReply): void {
  ai = fakeAnthropic(reply);
  deps = makeTestDeps({ anthropic: ai.client });
}
const svc = () => createClassroomService(deps, () => fake);
const find = (key: string) => deps.store.items.findByDedupeKey(key);

beforeEach(() => {
  fake = new FakeClassroomApi();
  fake.courses = [{ id: "c1", name: "S3 Chemistry" }];
});

describe("Classroom announcement sync", () => {
  it("summarises a new announcement into an info item", async () => {
    withModel(() => jsonReply({
      title: "Lab coats from next week", summary: "Bring your lab coat for practicals from Mon 19 Oct.",
      dueAt: null, urgency: "low", urgencyReason: null,
    }));
    fake.announcements.c1 = [announcement({ id: "a1", text: "From next week please bring lab coats." })];
    const res = await svc().sync();
    expect(res).toMatchObject({ fetched: 1, triaged: 1, alerts: [] });
    expect(await find("classroom:announcement:a1")).toMatchObject({
      type: "info",
      title: "Lab coats from next week",
      details: "S3 Chemistry: Bring your lab coat for practicals from Mon 19 Oct.",
      dueAt: null,
      urgency: "low",
      status: "open",
      source: {
        kind: "classroom", courseId: "c1", courseName: "S3 Chemistry", courseWorkId: null, announcementId: "a1",
        link: "https://classroom.google.com/c/c1/p/a1",
      },
    });
    expect(ai.requests).toHaveLength(1);
  });

  it("an announcement with a deadline becomes a deadline item and can alert", async () => {
    withModel(() => jsonReply({
      title: "Submit consent form", summary: "Return the signed form by tomorrow 3pm.",
      dueAt: "2026-10-15T15:00:00+08:00", urgency: "urgent", urgencyReason: "due within 36h",
    }));
    fake.announcements.c1 = [announcement({ id: "a2", text: "Please return the signed consent form by tomorrow 3pm." })];
    const res = await svc().sync();
    expect(res.alerts.map((i) => i.dedupeKey)).toEqual(["classroom:announcement:a2"]);
    expect(await find("classroom:announcement:a2")).toMatchObject({
      type: "deadline", dueAt: "2026-10-15T07:00:00.000Z", urgency: "urgent", urgencyReason: "due within 36h", alertedAt: null,
    });
  });

  it("never calls the model twice for the same announcement", async () => {
    withModel(() => jsonReply({ title: "Quiz on Friday", summary: "Short quiz Fri.", dueAt: null, urgency: "normal", urgencyReason: null }));
    fake.announcements.c1 = [announcement({ id: "a1" })];
    await svc().sync();
    deps.clock.advance(31 * 60_000);
    await svc().sync();
    expect(ai.requests).toHaveLength(1);
    expect(await deps.store.items.list({})).toHaveLength(1);
  });

  it("retries an announcement whose item failed to save", async () => {
    withModel(() => jsonReply({ title: "Quiz on Friday", summary: "Short quiz Fri.", dueAt: null, urgency: "normal", urgencyReason: null }));
    fake.announcements.c1 = [announcement({ id: "a1" })];
    const realCreate = deps.store.items.create;
    let failures = 1;
    deps.store.items.create = async (data) => {
      if (failures-- > 0) throw new Error("firestore unavailable");
      return realCreate(data);
    };
    await svc().sync();
    expect(await find("classroom:announcement:a1")).toBeNull();
    deps.clock.advance(31 * 60_000);
    await svc().sync();
    expect(await find("classroom:announcement:a1")).toMatchObject({ title: "Quiz on Friday" });
  });

  it("ignores announcements created more than 7 days ago", async () => {
    withModel(() => jsonReply({ title: "x", summary: "x", dueAt: null, urgency: "normal", urgencyReason: null }));
    fake.announcements.c1 = [
      announcement({ id: "old", creationTime: "2026-10-06T23:59:59.000Z", updateTime: "2026-10-08T00:00:00.000Z" }),
    ];
    const res = await svc().sync();
    expect(res.fetched).toBe(0);
    expect(ai.requests).toHaveLength(0);
    expect(await deps.store.items.list({})).toEqual([]);
  });

  it("falls back to a plain info item when the model refuses", async () => {
    withModel(() => ({ text: "", stopReason: "refusal" }));
    fake.announcements.c1 = [announcement({ id: "a3", text: "Reminder: CCA briefing in the hall\nat 2pm today." })];
    const res = await svc().sync();
    expect(res.triaged).toBe(0);
    expect(await find("classroom:announcement:a3")).toMatchObject({
      type: "info",
      title: "Reminder: CCA briefing in the hall",
      details: "S3 Chemistry\nReminder: CCA briefing in the hall\nat 2pm today.",
      urgency: "normal",
    });
  });

  it("an announcement with no text skips the model", async () => {
    withModel(() => jsonReply({ title: "x", summary: "x", dueAt: null, urgency: "normal", urgencyReason: null }));
    fake.announcements.c1 = [announcement({ id: "a4", text: "   " })];
    await svc().sync();
    expect(ai.requests).toHaveLength(0);
    expect(await find("classroom:announcement:a4")).toMatchObject({ type: "info", title: "New post in S3 Chemistry" });
  });

  it("an announcements failure does not block coursework", async () => {
    withModel(() => jsonReply({ title: "x", summary: "x", dueAt: null, urgency: "normal", urgencyReason: null }));
    fake.errors.announcements = Object.assign(new Error("forbidden"), { status: 403 });
    fake.work.c1 = [courseWork({ id: "w1", dueAt: "2026-10-19T15:59:00.000Z" })];
    const res = await svc().sync();
    expect(await find("classroom:w1")).not.toBeNull();
    expect(res.fetched).toBe(1);
  });
});
