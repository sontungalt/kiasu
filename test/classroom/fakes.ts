import type {
  ClassroomAnnouncement, ClassroomApi, ClassroomCourse, ClassroomCourseWork, ClassroomSubmission,
} from "../../src/classroom/api.js";

export class FakeClassroomApi implements ClassroomApi {
  courses: ClassroomCourse[] = [];
  work: Record<string, ClassroomCourseWork[]> = {};
  submissions: Record<string, ClassroomSubmission[]> = {};
  announcements: Record<string, ClassroomAnnouncement[]> = {};
  /**
   * Errors to throw, keyed by "courses", or by "<kind>" or "<kind>:<courseId>"
   * where kind is courseWork | submissions | announcements.
   */
  errors: Record<string, unknown> = {};
  /** Every call made, as "courses" or "<kind>:<courseId>". */
  calls: string[] = [];

  private hit(kind: string, courseId?: string): void {
    const key = courseId ? `${kind}:${courseId}` : kind;
    this.calls.push(key);
    const err = this.errors[key] ?? this.errors[kind];
    if (err) throw err;
  }

  async listStudentCourses(): Promise<ClassroomCourse[]> {
    this.hit("courses");
    return this.courses;
  }
  async listCourseWork(courseId: string): Promise<ClassroomCourseWork[]> {
    this.hit("courseWork", courseId);
    return this.work[courseId] ?? [];
  }
  async listMySubmissions(courseId: string): Promise<ClassroomSubmission[]> {
    this.hit("submissions", courseId);
    return this.submissions[courseId] ?? [];
  }
  async listRecentAnnouncements(courseId: string, _sinceIso: string): Promise<ClassroomAnnouncement[]> {
    this.hit("announcements", courseId);
    return this.announcements[courseId] ?? [];
  }
}

export function courseWork(over: Partial<ClassroomCourseWork> & { id: string }): ClassroomCourseWork {
  return {
    courseId: "c1",
    title: `Assignment ${over.id}`,
    description: null,
    link: `https://classroom.google.com/c/c1/a/${over.id}/details`,
    creationTime: "2026-10-10T00:00:00.000Z",
    dueAt: null,
    ...over,
  };
}

export function announcement(over: Partial<ClassroomAnnouncement> & { id: string }): ClassroomAnnouncement {
  return {
    text: `Announcement ${over.id}`,
    link: `https://classroom.google.com/c/c1/p/${over.id}`,
    creationTime: "2026-10-13T07:00:00.000Z",
    updateTime: "2026-10-13T07:00:00.000Z",
    ...over,
  };
}
