import { describe, it, expect } from "vitest";
import { createClassroomService } from "../../src/classroom/service.js";
import type { ClassroomApiFactory } from "../../src/classroom/api.js";
import { EMPTY_SYNC } from "../../src/ports.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/log.js";
import { makeTestDeps } from "../helpers/deps.js";
import { TEST_ENV } from "../helpers/env.js";
import { FakeClassroomApi } from "./fakes.js";

const MIN = 60_000;
const coursesCalls = (fake: FakeClassroomApi) => fake.calls.filter((c) => c === "courses").length;
const noApi: ClassroomApiFactory = () => {
  throw new Error("Classroom API must not be built");
};

function captureLog() {
  const lines: string[] = [];
  return {
    log: createLogger({}, (l) => lines.push(l)),
    warnings: () => lines.map((l) => JSON.parse(l)).filter((l) => l.severity === "WARNING"),
  };
}

describe("ClassroomService guards and throttling", () => {
  it("does nothing when CLASSROOM_ENABLED=false", async () => {
    const deps = makeTestDeps({ config: loadConfig({ ...TEST_ENV, CLASSROOM_ENABLED: "false" }) });
    const svc = createClassroomService(deps, noApi);
    expect(await svc.syncIfDue()).toEqual(EMPTY_SYNC);
    expect(await svc.sync()).toEqual(EMPTY_SYNC);
    expect(await deps.store.state.get("classroom")).toBeNull();
  });

  it("syncs when never synced, then waits settings.classroomSyncMinutes", async () => {
    const deps = makeTestDeps();
    const fake = new FakeClassroomApi();
    const svc = createClassroomService(deps, () => fake);
    await svc.syncIfDue();
    expect(coursesCalls(fake)).toBe(1);
    expect(await deps.store.state.get("classroom")).toEqual({ lastSyncAt: "2026-10-14T00:00:00.000Z" });
    deps.clock.advance(29 * MIN);
    expect(await svc.syncIfDue()).toEqual(EMPTY_SYNC);
    expect(coursesCalls(fake)).toBe(1);
    deps.clock.advance(1 * MIN);
    await svc.syncIfDue();
    expect(coursesCalls(fake)).toBe(2);
  });

  it("honours a custom classroomSyncMinutes", async () => {
    const deps = makeTestDeps();
    deps.store.settingsOverride = { classroomSyncMinutes: 5 };
    await deps.store.state.set("classroom", { lastSyncAt: "2026-10-13T23:54:00.000Z" }); // 6 minutes ago
    const fake = new FakeClassroomApi();
    await createClassroomService(deps, () => fake).syncIfDue();
    expect(coursesCalls(fake)).toBe(1);
  });

  it("403 PERMISSION_DENIED returns EMPTY_SYNC, records the attempt and warns only once", async () => {
    const { log, warnings } = captureLog();
    const deps = makeTestDeps({ log });
    const fake = new FakeClassroomApi();
    fake.errors.courses = Object.assign(new Error("The caller does not have permission"), { status: 403 });
    const svc = createClassroomService(deps, () => fake);
    expect(await svc.sync()).toEqual(EMPTY_SYNC);
    deps.clock.advance(31 * MIN);
    expect(await svc.syncIfDue()).toEqual(EMPTY_SYNC);
    expect(coursesCalls(fake)).toBe(2);
    expect(await deps.store.state.get("classroom")).toEqual({ lastSyncAt: "2026-10-14T00:31:00.000Z" });
    expect(warnings().filter((w) => /permission denied/.test(w.message))).toHaveLength(1);
  });

  it("recognises @ClassroomApiDisabled in the response body", async () => {
    const deps = makeTestDeps();
    const fake = new FakeClassroomApi();
    fake.errors.courses = {
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "@ClassroomApiDisabled The user is not permitted to access the Classroom API.",
          },
        },
      },
    };
    expect(await createClassroomService(deps, () => fake).sync()).toEqual(EMPTY_SYNC);
  });

  it("invalid_grant returns EMPTY_SYNC and records the attempt", async () => {
    const deps = makeTestDeps();
    const fake = new FakeClassroomApi();
    fake.errors.courses = Object.assign(new Error("invalid_grant: Token has been expired or revoked."), {
      response: { data: { error: "invalid_grant" } },
    });
    expect(await createClassroomService(deps, () => fake).sync()).toEqual(EMPTY_SYNC);
    expect(await deps.store.state.get("classroom")).toEqual({ lastSyncAt: "2026-10-14T00:00:00.000Z" });
  });

  it("unexpected errors propagate but still record the attempt", async () => {
    const deps = makeTestDeps();
    const fake = new FakeClassroomApi();
    fake.errors.courses = new Error("socket hang up");
    await expect(createClassroomService(deps, () => fake).sync()).rejects.toThrow("socket hang up");
    expect(await deps.store.state.get("classroom")).toEqual({ lastSyncAt: "2026-10-14T00:00:00.000Z" });
  });

  it("skips without a school refresh token or when the school account is revoked", async () => {
    const noToken = makeTestDeps({ config: loadConfig({ ...TEST_ENV, GOOGLE_REFRESH_TOKEN_SCHOOL: "" }) });
    expect(await createClassroomService(noToken, noApi).sync()).toEqual(EMPTY_SYNC);

    const revoked = makeTestDeps();
    await revoked.store.accounts.upsert({
      id: "school", email: "me@students.school.edu.sg", historyId: null, watchExpiresAt: null, lastSyncAt: null, authStatus: "revoked",
    });
    expect(await createClassroomService(revoked, noApi).sync()).toEqual(EMPTY_SYNC);
    expect(await revoked.store.state.get("classroom")).not.toBeNull();
  });
});
