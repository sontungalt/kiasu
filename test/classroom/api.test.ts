import { describe, it, expect } from "vitest";
import {
  classroomApiFromClient, googleClassroomApi, isPermissionDenied,
  type ClassroomRawClient, type RawAnnouncement, type RawCourse, type RawCourseWork, type RawSubmission,
} from "../../src/classroom/api.js";
import { googleAuthFor } from "../../src/google/auth.js";
import { loadConfig } from "../../src/config.js";
import { TEST_ENV } from "../helpers/env.js";

/** Pages are addressed by token "1", "2", ... (the first call has no token). */
function pageAt<T>(pages: T[][], token?: string): { page: T[]; next: string | null } {
  const i = token ? Number(token) : 0;
  return { page: pages[i] ?? [], next: i + 1 < pages.length ? String(i + 1) : null };
}

function rawClient(over: Partial<ClassroomRawClient>): ClassroomRawClient {
  const notStubbed = async (): Promise<never> => {
    throw new Error("not stubbed");
  };
  return { coursesList: notStubbed, courseWorkList: notStubbed, submissionsList: notStubbed, announcementsList: notStubbed, ...over };
}

describe("isPermissionDenied", () => {
  it("recognises 403 / PERMISSION_DENIED / @ClassroomApiDisabled shapes", () => {
    expect(isPermissionDenied({ status: 403 })).toBe(true);
    expect(isPermissionDenied({ code: 403 })).toBe(true);
    expect(isPermissionDenied({ code: "403" })).toBe(true);
    expect(isPermissionDenied({ response: { status: 403 } })).toBe(true);
    expect(isPermissionDenied({ response: { data: { error: { code: 403, status: "PERMISSION_DENIED", message: "x" } } } })).toBe(true);
    expect(isPermissionDenied(new Error("@ClassroomApiDisabled The user is not permitted to access the Classroom API."))).toBe(true);
  });

  it("ignores other errors", () => {
    expect(isPermissionDenied({ status: 500 })).toBe(false);
    expect(isPermissionDenied(new Error("socket hang up"))).toBe(false);
    expect(isPermissionDenied(null)).toBe(false);
    expect(isPermissionDenied("403")).toBe(false);
  });
});

describe("classroomApiFromClient", () => {
  it("lists ACTIVE courses where I am a student, across pages (35 courses)", async () => {
    const active: RawCourse[] = Array.from({ length: 35 }, (_, i) => ({ id: `c${i}`, name: `Class ${i}`, courseState: "ACTIVE" }));
    const pages: RawCourse[][] = [
      active.slice(0, 30),
      [...active.slice(30), { id: "old", name: "2025 Math", courseState: "ARCHIVED" }, { id: null, name: "broken" }],
    ];
    const params: Array<Parameters<ClassroomRawClient["coursesList"]>[0]> = [];
    const api = classroomApiFromClient(rawClient({
      coursesList: async (p) => {
        params.push(p);
        const { page, next } = pageAt(pages, p.pageToken);
        return { courses: page, nextPageToken: next };
      },
    }));
    const courses = await api.listStudentCourses();
    expect(courses).toHaveLength(35);
    expect(courses[34]).toEqual({ id: "c34", name: "Class 34" });
    expect(params[0]).toMatchObject({ studentId: "me", courseStates: ["ACTIVE"] });
    expect(params[0]).not.toHaveProperty("teacherId");
    expect(params.map((p) => p.pageToken)).toEqual([undefined, "1"]);
  });

  it("maps PUBLISHED course work with UTC due instants, across pages", async () => {
    const pages: RawCourseWork[][] = [
      [{
        id: "w1", title: " Lab report ", description: "  Write up titration  ", state: "PUBLISHED",
        alternateLink: "https://classroom.google.com/c/x/a/w1", creationTime: "2026-10-01T02:00:00Z",
        dueDate: { year: 2026, month: 10, day: 15 }, dueTime: { hours: 15, minutes: 59 },
      }],
      [{ id: "w2", title: "", state: "PUBLISHED" }, { id: "w3", title: "Draft", state: "DRAFT" }, { id: null, title: "x" }],
    ];
    const params: Array<Parameters<ClassroomRawClient["courseWorkList"]>[0]> = [];
    const api = classroomApiFromClient(rawClient({
      courseWorkList: async (p) => {
        params.push(p);
        const { page, next } = pageAt(pages, p.pageToken);
        return { courseWork: page, nextPageToken: next };
      },
    }));
    expect(await api.listCourseWork("c1")).toEqual([
      {
        id: "w1", courseId: "c1", title: "Lab report", description: "Write up titration",
        link: "https://classroom.google.com/c/x/a/w1", creationTime: "2026-10-01T02:00:00.000Z", dueAt: "2026-10-15T15:59:00.000Z",
      },
      { id: "w2", courseId: "c1", title: "(untitled assignment)", description: null, link: null, creationTime: null, dueAt: null },
    ]);
    expect(params).toHaveLength(2);
    expect(params[0]).toMatchObject({ courseId: "c1" });
  });

  it("lists my submissions for all course work (courseWorkId '-', userId 'me'), across pages", async () => {
    const pages: RawSubmission[][] = [
      [{ courseWorkId: "w1", state: "TURNED_IN" }],
      [{ courseWorkId: "w2", state: "CREATED" }, { courseWorkId: null, state: "CREATED" }, { courseWorkId: "w3" }],
    ];
    const params: Array<Parameters<ClassroomRawClient["submissionsList"]>[0]> = [];
    const api = classroomApiFromClient(rawClient({
      submissionsList: async (p) => {
        params.push(p);
        const { page, next } = pageAt(pages, p.pageToken);
        return { studentSubmissions: page, nextPageToken: next };
      },
    }));
    expect(await api.listMySubmissions("c1")).toEqual([
      { courseWorkId: "w1", state: "TURNED_IN" },
      { courseWorkId: "w2", state: "CREATED" },
      { courseWorkId: "w3", state: "STATE_UNSPECIFIED" },
    ]);
    expect(params).toHaveLength(2);
    expect(params[0]).toMatchObject({ courseId: "c1", courseWorkId: "-", userId: "me" });
  });

  it("stops paging announcements once they are older than the window", async () => {
    const since = "2026-10-07T00:00:00.000Z";
    const pages: RawAnnouncement[][] = [
      [
        {
          id: "a1", text: "Test moved", state: "PUBLISHED", alternateLink: "https://classroom.google.com/c/x/p/a1",
          creationTime: "2026-10-13T07:00:00+08:00", updateTime: "2026-10-13T07:00:00+08:00",
        },
        { id: "d", text: "draft", state: "DRAFT", creationTime: "2026-10-12T00:00:00Z", updateTime: "2026-10-12T00:00:00Z" },
        { id: "a0", text: "Old", state: "PUBLISHED", creationTime: "2026-10-01T00:00:00Z", updateTime: "2026-10-01T00:00:00Z" },
      ],
      [{ id: "never", text: "should not be fetched", creationTime: "2026-09-01T00:00:00Z", updateTime: "2026-09-01T00:00:00Z" }],
    ];
    const params: Array<Parameters<ClassroomRawClient["announcementsList"]>[0]> = [];
    const api = classroomApiFromClient(rawClient({
      announcementsList: async (p) => {
        params.push(p);
        const { page, next } = pageAt(pages, p.pageToken);
        return { announcements: page, nextPageToken: next };
      },
    }));
    const anns = await api.listRecentAnnouncements("c1", since);
    expect(anns.map((a) => a.id)).toEqual(["a1", "a0"]);
    expect(anns[0]).toEqual({
      id: "a1", text: "Test moved", link: "https://classroom.google.com/c/x/p/a1",
      creationTime: "2026-10-12T23:00:00.000Z", updateTime: "2026-10-12T23:00:00.000Z",
    });
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ courseId: "c1", orderBy: "updateTime desc" });
  });

  it("googleClassroomApi builds a client without touching the network", () => {
    const api = googleClassroomApi(googleAuthFor("school", loadConfig(TEST_ENV))!);
    expect(typeof api.listStudentCourses).toBe("function");
    expect(typeof api.listRecentAnnouncements).toBe("function");
  });
});
