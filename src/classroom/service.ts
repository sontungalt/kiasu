import type { ClassroomService, Deps, SyncResult } from "../ports.js";
import { EMPTY_SYNC } from "../ports.js";
import type { Settings } from "../types.js";
import { googleAuthFor, isInvalidGrant } from "../google/auth.js";
import {
  googleClassroomApi, isPermissionDenied,
  type ClassroomApi, type ClassroomApiFactory, type ClassroomCourse,
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

  const courseSteps: Array<[string, CourseStep]> = [];

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
