import type { ClassroomService, Deps, SyncResult } from "../ports.js";
import { EMPTY_SYNC } from "../ports.js";
import type { Settings } from "../types.js";
import { googleAuthFor, isInvalidGrant } from "../google/auth.js";
import { upsertItem, type ItemDraft, type UpsertResult } from "../items/upsert.js";
import { shouldAlert } from "../items/alerts.js";
import {
  googleClassroomApi, isPermissionDenied,
  type ClassroomApi, type ClassroomApiFactory, type ClassroomCourse, type ClassroomCourseWork,
} from "./api.js";

export type ClassroomDeps = Pick<Deps, "config" | "clock" | "log" | "store" | "anthropic">;

export interface SyncRun {
  now: Date;
  nowIso: string;
  settings: Settings;
  result: SyncResult;
}

export type CourseStep = (client: ClassroomApi, course: ClassroomCourse, run: SyncRun) => Promise<void>;

/** A fresh copy each time, so no caller can mutate the shared EMPTY_SYNC.alerts array. */
const empty = (): SyncResult => ({ ...EMPTY_SYNC, alerts: [] });

export const DAY_MS = 86_400_000;
/** Overdue work older than this is not turned into a new item (avoids a first-sync flood). */
export const STALE_DUE_DAYS = 14;
/** Undated work created longer ago than this is not turned into a new item. */
export const STALE_UNDATED_DAYS = 30;
const DETAILS_MAX = 500;
const FINISHED_STATES = new Set(["TURNED_IN", "RETURNED"]);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function courseDetails(courseName: string, text: string | null): string {
  const body = (text ?? "").trim();
  return body ? `${courseName}\n${clip(body, DETAILS_MAX)}` : courseName;
}

export function isStale(w: ClassroomCourseWork, now: Date): boolean {
  if (w.dueAt) return Date.parse(w.dueAt) < now.getTime() - STALE_DUE_DAYS * DAY_MS;
  if (w.creationTime) return Date.parse(w.creationTime) < now.getTime() - STALE_UNDATED_DAYS * DAY_MS;
  return false;
}

export function createClassroomService(
  deps: ClassroomDeps,
  api: ClassroomApiFactory = googleClassroomApi,
): ClassroomService {
  const { config, clock, store } = deps;
  const log = deps.log.child({ module: "classroom" });
  const deniedWarned = new Set<string>();

  function warnDeniedOnce(scope: string, err: unknown, fields: Record<string, unknown> = {}): void {
    if (deniedWarned.has(scope)) return;
    deniedWarned.add(scope);
    log.warn(
      "classroom permission denied (the school admin may have disabled the Classroom API or a scope); set CLASSROOM_ENABLED=false to turn Classroom off",
      { scope, err, ...fields },
    );
  }

  /** Classroom items are school work, so they alert like a high-importance email (§8.3). The Notifier sets alertedAt. */
  function collect(res: UpsertResult, run: SyncRun): void {
    if (shouldAlert(res, { importance: "high", senderEmail: null }, run.settings, run.now)) run.result.alerts.push(res.item);
  }

  async function markDone(dedupeKey: string, nowIso: string): Promise<void> {
    const existing = await store.items.findByDedupeKey(dedupeKey);
    if (existing && (existing.status === "open" || existing.status === "snoozed")) {
      await store.items.update(existing.id, { status: "done", updatedAt: nowIso });
    }
  }

  const syncCourseWork: CourseStep = async (client, course, run) => {
    const [work, submissions] = await Promise.all([client.listCourseWork(course.id), client.listMySubmissions(course.id)]);
    const stateOf = new Map(submissions.map((s) => [s.courseWorkId, s.state]));
    for (const w of work) {
      run.result.fetched++;
      const dedupeKey = `classroom:${w.id}`;
      // A missing submission counts as "not turned in".
      if (FINISHED_STATES.has(stateOf.get(w.id) ?? "")) {
        await markDone(dedupeKey, run.nowIso);
        continue;
      }
      if (isStale(w, run.now) && !(await store.items.findByDedupeKey(dedupeKey))) continue;
      const draft: ItemDraft = {
        type: w.dueAt ? "deadline" : "task",
        title: w.title,
        details: courseDetails(course.name, w.description),
        dueAt: w.dueAt,
        startAt: null,
        endAt: null,
        urgency: "normal",
        urgencyReason: null,
        source: {
          kind: "classroom", courseId: course.id, courseName: course.name, courseWorkId: w.id, announcementId: null, link: w.link,
        },
        dedupeKey,
      };
      collect(await upsertItem(store, draft, run.now), run);
    }
  };

  const courseSteps: Array<[string, CourseStep]> = [["coursework", syncCourseWork]];

  async function runSync(client: ClassroomApi): Promise<SyncResult> {
    const now = clock.now();
    const run: SyncRun = { now, nowIso: now.toISOString(), settings: await store.settings.get(), result: empty() };
    const courses = await client.listStudentCourses();
    for (const course of courses) {
      for (const [name, step] of courseSteps) {
        try {
          await step(client, course, run);
        } catch (err) {
          if (isInvalidGrant(err)) throw err;
          if (isPermissionDenied(err)) warnDeniedOnce(name, err, { courseId: course.id });
          else log.warn("classroom course step failed", { step: name, courseId: course.id, err });
        }
      }
    }
    log.info("classroom synced", {
      courses: courses.length,
      fetched: run.result.fetched,
      triaged: run.result.triaged,
      alerts: run.result.alerts.length,
    });
    return run.result;
  }

  async function sync(): Promise<SyncResult> {
    if (!config.CLASSROOM_ENABLED) return empty();
    try {
      const account = await store.accounts.get("school");
      if (account?.authStatus === "revoked") {
        log.warn("classroom skipped: school account is revoked");
        return empty();
      }
      const auth = googleAuthFor("school", config);
      if (!auth) {
        log.info("classroom skipped: no school refresh token");
        return empty();
      }
      return await runSync(api(auth));
    } catch (err) {
      if (isInvalidGrant(err)) {
        log.warn("classroom skipped: invalid_grant (school token revoked or expired)");
        return empty();
      }
      if (isPermissionDenied(err)) {
        warnDeniedOnce("courses", err);
        return empty();
      }
      throw err;
    } finally {
      // Record every attempt so a broken Classroom is retried every classroomSyncMinutes, not every tick.
      await store.state.set("classroom", { lastSyncAt: clock.now().toISOString() });
    }
  }

  async function syncIfDue(): Promise<SyncResult> {
    if (!config.CLASSROOM_ENABLED) return empty();
    const [state, settings] = await Promise.all([store.state.get("classroom"), store.settings.get()]);
    const last = state?.lastSyncAt ? Date.parse(state.lastSyncAt) : null;
    if (last !== null && clock.now().getTime() - last < settings.classroomSyncMinutes * 60_000) return empty();
    return sync();
  }

  return { sync, syncIfDue };
}
