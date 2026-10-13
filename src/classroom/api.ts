import { google } from "googleapis";
import type { GoogleAuth } from "../google/auth.js";
import { collectPages } from "../google/collect-pages.js";
import { toUtcIso } from "../lib/clock.js";
import { classroomDueAt, type ClassroomDate, type ClassroomTimeOfDay } from "./due.js";

// ---- Raw shapes: subsets of googleapis classroom_v1 Schema$*. Every field is nullable. ----

export interface RawCourse {
  id?: string | null;
  name?: string | null;
  courseState?: string | null;
}

export interface RawCourseWork {
  id?: string | null;
  title?: string | null;
  description?: string | null;
  state?: string | null;
  alternateLink?: string | null;
  creationTime?: string | null;
  dueDate?: ClassroomDate | null;
  dueTime?: ClassroomTimeOfDay | null;
}

export interface RawSubmission {
  courseWorkId?: string | null;
  state?: string | null;
}

export interface RawAnnouncement {
  id?: string | null;
  text?: string | null;
  state?: string | null;
  alternateLink?: string | null;
  creationTime?: string | null;
  updateTime?: string | null;
}

interface Paged {
  pageSize: number;
  pageToken?: string;
}

/** The four googleapis calls we use, typed structurally so tests can fake them. */
export interface ClassroomRawClient {
  coursesList(p: Paged & { studentId: string; courseStates: string[] }): Promise<{
    courses?: RawCourse[] | null;
    nextPageToken?: string | null;
  }>;
  courseWorkList(p: Paged & { courseId: string }): Promise<{
    courseWork?: RawCourseWork[] | null;
    nextPageToken?: string | null;
  }>;
  submissionsList(p: Paged & { courseId: string; courseWorkId: string; userId: string }): Promise<{
    studentSubmissions?: RawSubmission[] | null;
    nextPageToken?: string | null;
  }>;
  announcementsList(p: Paged & { courseId: string; orderBy: string }): Promise<{
    announcements?: RawAnnouncement[] | null;
    nextPageToken?: string | null;
  }>;
}

// ---- Domain shapes used by the service ----

export interface ClassroomCourse {
  id: string;
  name: string;
}

export interface ClassroomCourseWork {
  id: string;
  courseId: string;
  title: string;
  description: string | null;
  link: string | null;
  creationTime: string | null; // UTC ISO
  dueAt: string | null; // UTC ISO, from classroomDueAt
}

export interface ClassroomSubmission {
  courseWorkId: string;
  /** CREATED | TURNED_IN | RETURNED | RECLAIMED_BY_STUDENT | STUDENT_EDITED_AFTER_TURN_IN | STATE_UNSPECIFIED */
  state: string;
}

export interface ClassroomAnnouncement {
  id: string;
  text: string;
  link: string | null;
  creationTime: string; // UTC ISO
  updateTime: string; // UTC ISO
}

export interface ClassroomApi {
  /** ACTIVE courses where I'm a student (studentId "me"), so courses I teach are excluded. All pages. */
  listStudentCourses(): Promise<ClassroomCourse[]>;
  /** PUBLISHED course work in the course. All pages. */
  listCourseWork(courseId: string): Promise<ClassroomCourseWork[]>;
  /** My submissions for every course work in the course (courseWorkId "-", userId "me"). All pages. */
  listMySubmissions(courseId: string): Promise<ClassroomSubmission[]>;
  /**
   * PUBLISHED announcements, most recently updated first. Paging stops after the first page whose
   * last item was updated before `sinceIso` (UTC ISO), so the result may include a few older ones.
   */
  listRecentAnnouncements(courseId: string, sinceIso: string): Promise<ClassroomAnnouncement[]>;
}

export type ClassroomApiFactory = (auth: GoogleAuth) => ClassroomApi;

const PAGE_SIZE = 100;
const ANNOUNCEMENT_PAGE_SIZE = 50;

function safeUtc(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    return toUtcIso(v);
  } catch {
    return null;
  }
}

const isPublished = (state: string | null | undefined) => !state || state === "PUBLISHED";

export function classroomApiFromClient(raw: ClassroomRawClient): ClassroomApi {
  return {
    async listStudentCourses() {
      const courses = await collectPages(async (pageToken) => {
        const res = await raw.coursesList({ studentId: "me", courseStates: ["ACTIVE"], pageSize: PAGE_SIZE, pageToken });
        return { items: res.courses ?? [], nextPageToken: res.nextPageToken };
      });
      return courses
        .filter((c) => !!c.id && (!c.courseState || c.courseState === "ACTIVE"))
        .map((c) => ({ id: c.id as string, name: c.name?.trim() || "(unnamed class)" }));
    },

    async listCourseWork(courseId) {
      const work = await collectPages(async (pageToken) => {
        const res = await raw.courseWorkList({ courseId, pageSize: PAGE_SIZE, pageToken });
        return { items: res.courseWork ?? [], nextPageToken: res.nextPageToken };
      });
      return work
        .filter((w) => !!w.id && isPublished(w.state))
        .map((w) => ({
          id: w.id as string,
          courseId,
          title: w.title?.trim() || "(untitled assignment)",
          description: w.description?.trim() || null,
          link: w.alternateLink ?? null,
          creationTime: safeUtc(w.creationTime),
          dueAt: classroomDueAt(w.dueDate, w.dueTime),
        }));
    },

    async listMySubmissions(courseId) {
      const subs = await collectPages(async (pageToken) => {
        const res = await raw.submissionsList({ courseId, courseWorkId: "-", userId: "me", pageSize: PAGE_SIZE, pageToken });
        return { items: res.studentSubmissions ?? [], nextPageToken: res.nextPageToken };
      });
      return subs
        .filter((s) => !!s.courseWorkId)
        .map((s) => ({ courseWorkId: s.courseWorkId as string, state: s.state ?? "STATE_UNSPECIFIED" }));
    },

    async listRecentAnnouncements(courseId, sinceIso) {
      const anns = await collectPages(
        async (pageToken) => {
          const res = await raw.announcementsList({
            courseId, orderBy: "updateTime desc", pageSize: ANNOUNCEMENT_PAGE_SIZE, pageToken,
          });
          return { items: res.announcements ?? [], nextPageToken: res.nextPageToken };
        },
        {
          stopAfter: (items) => {
            const last = items[items.length - 1];
            if (!last) return true;
            const t = safeUtc(last.updateTime);
            return t !== null && t < sinceIso;
          },
        },
      );
      const out: ClassroomAnnouncement[] = [];
      for (const a of anns) {
        const creationTime = safeUtc(a.creationTime);
        if (!a.id || !creationTime || !isPublished(a.state)) continue;
        out.push({
          id: a.id,
          text: a.text ?? "",
          link: a.alternateLink ?? null,
          creationTime,
          updateTime: safeUtc(a.updateTime) ?? creationTime,
        });
      }
      return out;
    },
  };
}

/**
 * True for "you may not use Classroom" errors: HTTP 403 / PERMISSION_DENIED, including
 * "@ClassroomApiDisabled" (the admin turned the API off) and missing scopes.
 * Handles the GaxiosError shapes (`status`, `code`, `response.status`, `response.data.error`).
 */
export function isPermissionDenied(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    response?: { status?: unknown; data?: { error?: { status?: unknown; message?: unknown } } };
  };
  if (e.status === 403 || e.code === 403 || e.code === "403" || e.response?.status === 403) return true;
  const body = e.response?.data?.error;
  if (body?.status === "PERMISSION_DENIED") return true;
  const text = `${typeof e.message === "string" ? e.message : ""} ${typeof body?.message === "string" ? body.message : ""}`;
  return text.includes("@ClassroomApiDisabled") || text.includes("PERMISSION_DENIED");
}

export const googleClassroomApi: ClassroomApiFactory = (auth) => {
  const c = google.classroom({ version: "v1", auth });
  return classroomApiFromClient({
    coursesList: async (p) => (await c.courses.list(p)).data,
    courseWorkList: async (p) => (await c.courses.courseWork.list(p)).data,
    submissionsList: async (p) => (await c.courses.courseWork.studentSubmissions.list(p)).data,
    announcementsList: async (p) => (await c.courses.announcements.list(p)).data,
  });
};
