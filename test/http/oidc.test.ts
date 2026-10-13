import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { verifyGoogleOidc, oidcPreHandler, type IdTokenVerifier } from "../../src/http/oidc.js";
import { loadConfig } from "../../src/config.js";
import { silentLogger } from "../../src/lib/log.js";
import { TEST_ENV } from "../helpers/env.js";

const INVOKER = TEST_ENV.INVOKER_SERVICE_ACCOUNT!;
const okVerifier: IdTokenVerifier = async (token, audience) =>
  token === "good" && audience === "https://bot.example.com/jobs/tick" ? { email: INVOKER, email_verified: true } : undefined;

describe("verifyGoogleOidc", () => {
  const opts = { audience: "https://bot.example.com/jobs/tick", email: INVOKER };
  it("accepts a valid token for the right account", async () => {
    expect(await verifyGoogleOidc("Bearer good", opts, okVerifier)).toBe(true);
  });
  it("rejects missing, malformed, wrong-audience and wrong-email", async () => {
    expect(await verifyGoogleOidc(undefined, opts, okVerifier)).toBe(false);
    expect(await verifyGoogleOidc("Basic x", opts, okVerifier)).toBe(false);
    expect(await verifyGoogleOidc("Bearer good", { ...opts, audience: "https://bot.example.com/other" }, okVerifier)).toBe(false);
    expect(await verifyGoogleOidc("Bearer good", { ...opts, email: "evil@x.com" }, okVerifier)).toBe(false);
  });
  it("treats verifier exceptions as rejection", async () => {
    expect(await verifyGoogleOidc("Bearer x", opts, async () => { throw new Error("bad sig"); })).toBe(false);
  });
});

describe("oidcPreHandler", () => {
  async function app(env: Record<string, string>) {
    const config = loadConfig({ ...TEST_ENV, ...env });
    const a = Fastify();
    a.post("/jobs/tick", { preHandler: oidcPreHandler({ config, log: silentLogger }, okVerifier) }, async () => ({ ok: true }));
    return a;
  }
  it("401 without token, 200 with token", async () => {
    const a = await app({});
    expect((await a.inject({ method: "POST", url: "/jobs/tick" })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url: "/jobs/tick?x=1", headers: { authorization: "Bearer good" } })).statusCode).toBe(200);
  });
  it("DEV_SKIP_OIDC bypasses outside production", async () => {
    const a = await app({ DEV_SKIP_OIDC: "true" });
    expect((await a.inject({ method: "POST", url: "/jobs/tick" })).statusCode).toBe(200);
  });
});
