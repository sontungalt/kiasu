import { describe, it, expect, beforeEach } from "vitest";
import { createClassroomService } from "../../src/classroom/service.js";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import { FakeClassroomApi, courseWork } from "./fakes.js";

// makeTestDeps clock: 2026-10-14T00:00:00Z = Wed 14 Oct 08:00 SGT
const TONIGHT = "2026-10-14T15:59:00.000Z"; // 23:59 SGT today, 16h away, inside the 36h window
const NEXT_WEEK = "2026-10-19T15:59:00.000Z";

let deps: TestDeps;
let fake: FakeClassroomApi;
const svc = () => createClassroomService(deps, () => fake);
const find = (key: string) => deps.store.items.findByDedupeKey(key);

beforeEach(() => {
  deps = makeTestDeps();
  fake = new FakeClassroomApi();
  fake.courses = [{ id: "c1", name: "S3 Chemistry" }];
});

describe("Classroom coursework sync", () => {
  it("turns unsubmitted work with a due date into a deadline item", async () => {
    fake.work.c1 = [courseWork({ id: "w1", title: "Titration lab report", description: "Use the template.\n\n", dueAt: NEXT_WEEK })];
    fake.submissions.c1 = [{ courseWorkId: "w1", state: "CREATED" }];
    const res = await svc().sync();
    expect(res).toMatchObject({ fetched: 1, triaged: 0, alerts: [] });
    expect(await find("classroom:w1")).toMatchObject({
      type: "deadline",
      title: "Titration lab report",
      details: "S3 Chemistry\nUse the template.",
      dueAt: NEXT_WEEK,
      status: "open",
      urgency: "normal",
      source: {
        kind: "classroom", courseId: "c1", courseName: "S3 Chemistry", courseWorkId: "w1", announcementId: null,
        link: "https://classroom.google.com/c/c1/a/w1/details",
      },
    });
  });

  it("alerts for work due inside the urgent window, leaves alertedAt to the Notifier, and does not repeat", async () => {
    // No submissions at all: missing submission counts as not turned in.
    fake.work.c1 = [courseWork({ id: "w1", dueAt: TONIGHT }), courseWork({ id: "w2", dueAt: NEXT_WEEK })];
    const first = await svc().sync();
    expect(first.alerts.map((i) => i.dedupeKey)).toEqual(["classroom:w1"]);
    expect(first.alerts[0]!.alertedAt).toBeNull();
    expect((await find("classroom:w1"))!.alertedAt).toBeNull();
    const second = await svc().sync();
    expect(second.alerts).toEqual([]);
    expect(await deps.store.items.list({})).toHaveLength(2);
  });

  it("marks the item done once the work is turned in or returned", async () => {
    fake.work.c1 = [courseWork({ id: "w1", dueAt: NEXT_WEEK }), courseWork({ id: "w2", dueAt: NEXT_WEEK })];
    fake.submissions.c1 = [{ courseWorkId: "w1", state: "CREATED" }, { courseWorkId: "w2", state: "CREATED" }];
    await svc().sync();
    fake.submissions.c1 = [{ courseWorkId: "w1", state: "TURNED_IN" }, { courseWorkId: "w2", state: "RETURNED" }];
    deps.clock.advance(60 * 60_000);
    await svc().sync();
    expect(await find("classroom:w1")).toMatchObject({ status: "done", updatedAt: "2026-10-14T01:00:00.000Z" });
    expect((await find("classroom:w2"))!.status).toBe("done");
  });

  it("closes a snoozed item when the work is turned in", async () => {
    fake.work.c1 = [courseWork({ id: "w1", dueAt: NEXT_WEEK })];
    await svc().sync();
    const item = (await find("classroom:w1"))!;
    await deps.store.items.update(item.id, { status: "snoozed", snoozedUntil: "2026-10-15T00:00:00.000Z" });
    fake.submissions.c1 = [{ courseWorkId: "w1", state: "TURNED_IN" }];
    await svc().sync();
    expect((await find("classroom:w1"))!.status).toBe("done");
  });

  it("does not create items for work already turned in or returned", async () => {
    fake.work.c1 = [courseWork({ id: "w1", dueAt: NEXT_WEEK }), courseWork({ id: "w2" })];
    fake.submissions.c1 = [{ courseWorkId: "w1", state: "TURNED_IN" }, { courseWorkId: "w2", state: "RETURNED" }];
    await svc().sync();
    expect(await deps.store.items.list({})).toEqual([]);
  });

  it("work without a due date becomes a task with no dueAt", async () => {
    fake.work.c1 = [courseWork({ id: "w1", title: "Read chapter 4", dueAt: null })];
    const res = await svc().sync();
    expect(await find("classroom:w1")).toMatchObject({ type: "task", title: "Read chapter 4", dueAt: null, status: "open" });
    expect(res.alerts).toEqual([]);
  });

  it("a re-posted due date updates the same item and alerts again", async () => {
    fake.work.c1 = [courseWork({ id: "w1", dueAt: NEXT_WEEK })];
    expect((await svc().sync()).alerts).toEqual([]);
    fake.work.c1 = [courseWork({ id: "w1", dueAt: TONIGHT })];
    const moved = await svc().sync();
    expect(moved.alerts.map((i) => i.dedupeKey)).toEqual(["classroom:w1"]);
    expect(await find("classroom:w1")).toMatchObject({ dueAt: TONIGHT, status: "open" });
    expect(await deps.store.items.list({})).toHaveLength(1);
  });

  it("a done item is not reopened when unsubmitted or re-dated", async () => {
    fake.work.c1 = [courseWork({ id: "w1", dueAt: NEXT_WEEK })];
    fake.submissions.c1 = [{ courseWorkId: "w1", state: "CREATED" }];
    await svc().sync();
    fake.submissions.c1 = [{ courseWorkId: "w1", state: "TURNED_IN" }];
    await svc().sync();
    fake.work.c1 = [courseWork({ id: "w1", dueAt: TONIGHT })];
    fake.submissions.c1 = [{ courseWorkId: "w1", state: "RECLAIMED_BY_STUDENT" }];
    const res = await svc().sync();
    expect(res.alerts).toEqual([]);
    expect(await find("classroom:w1")).toMatchObject({ status: "done", dueAt: TONIGHT });
  });

  it("skips stale work on first sight but keeps recent overdue work", async () => {
    fake.work.c1 = [
      courseWork({ id: "old", dueAt: "2026-09-01T15:59:00.000Z" }),
      courseWork({ id: "undated-old", dueAt: null, creationTime: "2026-08-01T00:00:00.000Z" }),
      courseWork({ id: "overdue-recent", dueAt: "2026-10-10T15:59:00.000Z" }),
    ];
    const res = await svc().sync();
    expect((await deps.store.items.list({})).map((i) => i.dedupeKey)).toEqual(["classroom:overdue-recent"]);
    expect(res.fetched).toBe(3);
    expect(res.alerts).toEqual([]); // past-due items never alert as due-soon
  });

  it("a course that fails does not stop the others", async () => {
    fake.courses = [{ id: "c1", name: "S3 Chemistry" }, { id: "c2", name: "S3 Math" }];
    fake.errors["courseWork:c1"] = new Error("500 backend error");
    fake.work.c2 = [courseWork({ id: "m1", courseId: "c2", dueAt: NEXT_WEEK })];
    await svc().sync();
    expect(await find("classroom:m1")).toMatchObject({ source: { kind: "classroom", courseName: "S3 Math" } });
  });
});
