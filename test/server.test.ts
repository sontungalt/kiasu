import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";
import { makeTestDeps } from "./helpers/deps.js";

describe("server", () => {
  it("serves /healthz and runs registrars", async () => {
    const deps = makeTestDeps();
    const app = await buildServer(deps, [
      (a) => { a.get("/hello", async () => ({ hi: true })); },
    ]);
    expect((await app.inject("/healthz")).json()).toEqual({ ok: true });
    expect((await app.inject("/hello")).json()).toEqual({ hi: true });
  });

  it("turns thrown errors into 500 JSON without leaking the message", async () => {
    const app = await buildServer(makeTestDeps(), [
      (a) => { a.get("/boom", async () => { throw new Error("secret detail"); }); },
    ]);
    const res = await app.inject("/boom");
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
  });

  it("test deps stubs throw a helpful error", async () => {
    const deps = makeTestDeps();
    await expect(deps.mail.syncAccount("school")).rejects.toThrow("mail.syncAccount not stubbed");
  });
});
