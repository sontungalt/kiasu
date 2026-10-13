import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/server.js";
import { jobRoutes, registerJobRoutes } from "../../src/scheduler/routes.js";
import { loadConfig } from "../../src/config.js";
import type { IdTokenVerifier } from "../../src/http/oidc.js";
import { TEST_ENV } from "../helpers/env.js";
import { makeSchedulerDeps } from "../helpers/scheduler-fakes.js";

const WED_0800 = "2026-10-14T00:00:00.000Z";
const INVOKER = TEST_ENV.INVOKER_SERVICE_ACCOUNT!;
const okVerifier: IdTokenVerifier = async (token, audience) =>
  token === "good" && audience === "https://bot.example.com/jobs/tick" ? { email: INVOKER, email_verified: true } : undefined;
const devConfig = loadConfig({ ...TEST_ENV, DEV_SKIP_OIDC: "true" });

describe("POST /jobs/tick", () => {
  it("rejects calls without an OIDC token", async () => {
    const { deps } = makeSchedulerDeps(WED_0800);
    const app = await buildServer(deps, [registerJobRoutes]);
    expect((await app.inject({ method: "POST", url: "/jobs/tick" })).statusCode).toBe(401);
  });

  it("runs the tick at the real time with a valid token and ignores ?now", async () => {
    const { deps, outbox } = makeSchedulerDeps(WED_0800);
    const app = await buildServer(deps, [jobRoutes(okVerifier)]);
    const res = await app.inject({
      method: "POST", url: "/jobs/tick?now=2026-10-13T13:05:00.000Z", headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ "brief:morning": "ok", "brief:evening": "skipped" });
    expect(outbox.sent[0]?.text).toContain("*Good morning! Wed 14 Oct* ☀️");
  });

  it("with DEV_SKIP_OIDC, ?now sets the time", async () => {
    const { deps, outbox } = makeSchedulerDeps(WED_0800, { config: devConfig });
    const app = await buildServer(deps, [registerJobRoutes]);
    const res = await app.inject({ method: "POST", url: "/jobs/tick?now=2026-10-13T13:05:00.000Z" }); // Tue 21:05 SGT
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ "brief:morning": "skipped", "brief:evening": "ok" });
    expect(outbox.sent.map((m) => m.kind)).toEqual(["evening"]);
    expect(outbox.sent[0]?.text).toContain("*Evening check-in · Tue 13 Oct* 🌙");
  });

  it("with DEV_SKIP_OIDC, an invalid ?now is a 400", async () => {
    const { deps } = makeSchedulerDeps(WED_0800, { config: devConfig });
    const app = await buildServer(deps, [registerJobRoutes]);
    const res = await app.inject({ method: "POST", url: "/jobs/tick?now=yesterday-ish" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid now" });
  });

  it("accepts an empty JSON body from Cloud Scheduler", async () => {
    const { deps } = makeSchedulerDeps(WED_0800, { config: devConfig });
    const app = await buildServer(deps, [registerJobRoutes]);
    const res = await app.inject({
      method: "POST", url: "/jobs/tick", headers: { "content-type": "application/json" }, payload: "",
    });
    expect(res.statusCode).toBe(200);
  });
});
