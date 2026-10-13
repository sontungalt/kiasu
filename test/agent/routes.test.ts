import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/server.js";
import { registerTaskRoutes, isWindowAck, UNSUPPORTED_TEXT, SORRY_TEXT } from "../../src/agent/routes.js";
import { loadConfig } from "../../src/config.js";
import type { ChatAgent, OutboundMessage, Outbox } from "../../src/ports.js";
import type { InboundMessage } from "../../src/types.js";
import { makeTestDeps } from "../helpers/deps.js";
import { TEST_ENV } from "../helpers/env.js";

function fakeOutbox(flushCount = 0, failDeliver = false) {
  const delivered: OutboundMessage[] = [];
  let flushes = 0;
  const outbox: Outbox = {
    deliver: async (m) => {
      if (failDeliver) throw new Error("graph down");
      delivered.push(m);
      return "sent";
    },
    flush: async () => {
      flushes++;
      return flushCount;
    },
  };
  return { outbox, delivered, flushes: () => flushes };
}

function fakeAgent(answer: string | Error = "Here you go!") {
  const asked: string[] = [];
  const agent: ChatAgent = {
    reply: async (text) => {
      asked.push(text);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { agent, asked };
}

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return { id: "wamid.1", from: "6500000000", timestamp: "2026-10-14T00:00:00.000Z", type: "text",
    text: "what's due this week?", contextMessageId: null, ...over };
}

async function setup(opts: { flushCount?: number; answer?: string | Error; failDeliver?: boolean; skipOidc?: boolean } = {}) {
  const ob = fakeOutbox(opts.flushCount ?? 0, opts.failDeliver ?? false);
  const ag = fakeAgent(opts.answer);
  const deps = makeTestDeps({
    config: loadConfig({ ...TEST_ENV, DEV_SKIP_OIDC: opts.skipOidc === false ? "false" : "true" }),
    outbox: ob.outbox,
    agent: ag.agent,
  });
  const app = await buildServer(deps, [registerTaskRoutes]);
  const post = (body: unknown) => app.inject({ method: "POST", url: "/tasks/handle-message", payload: body as object });
  return { app, deps, post, ...ob, ...ag };
}

describe("isWindowAck", () => {
  it("matches short acknowledgements only", () => {
    for (const t of ["ok", "OK!", "Okay.", "show me", "Show me", "Details", "thanks", "👍", "k"]) expect(isWindowAck(t)).toBe(true);
    for (const t of ["ok what's due tomorrow?", "show me my deadlines", "done 2", "no", ""]) expect(isWindowAck(t)).toBe(false);
  });
});

describe("POST /tasks/handle-message", () => {
  it("requires OIDC", async () => {
    const { post, asked } = await setup({ skipOidc: false });
    expect((await post(inbound())).statusCode).toBe(401);
    expect(asked).toHaveLength(0);
  });

  it("text: flushes, asks the agent, delivers the reply with the heads_up template", async () => {
    const { post, asked, delivered, flushes } = await setup();
    const res = await post(inbound());
    expect(res.statusCode).toBe(200);
    expect(flushes()).toBe(1);
    expect(asked).toEqual(["what's due this week?"]);
    expect(delivered).toEqual([{ kind: "reply", text: "Here you go!", template: { name: "heads_up", params: ["You have a reply waiting"] } }]);
  });

  it("duplicate Cloud Task delivery is a no-op", async () => {
    const { post, asked, delivered, flushes } = await setup();
    await post(inbound());
    const again = await post(inbound());
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ duplicate: true });
    expect(asked).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(flushes()).toBe(1);
  });

  it("button: only flushes", async () => {
    const { post, asked, delivered, flushes } = await setup({ flushCount: 2 });
    await post(inbound({ type: "button", text: "Show me" }));
    expect(flushes()).toBe(1);
    expect(asked).toHaveLength(0);
    expect(delivered).toHaveLength(0);
  });

  it("unsupported: replies that only text is understood", async () => {
    const { post, asked, delivered } = await setup();
    await post(inbound({ type: "unsupported", text: null }));
    expect(asked).toHaveLength(0);
    expect(delivered.map((d) => d.text)).toEqual([UNSUPPORTED_TEXT]);
  });

  it("'ok' right after a flush skips the agent; 'ok' with nothing flushed does not", async () => {
    const flushed = await setup({ flushCount: 1 });
    await flushed.post(inbound({ text: "ok" }));
    expect(flushed.asked).toHaveLength(0);
    expect(flushed.delivered).toHaveLength(0);

    const quiet = await setup({ flushCount: 0 });
    await quiet.post(inbound({ text: "ok" }));
    expect(quiet.asked).toEqual(["ok"]);
  });

  it("a real question after a flush still goes to the agent", async () => {
    const { post, asked } = await setup({ flushCount: 3 });
    await post(inbound({ text: "show me my deadlines" }));
    expect(asked).toEqual(["show me my deadlines"]);
  });

  it("agent error: logs, sends an apology, still 200, and a retry doesn't run it again", async () => {
    const { post, asked, delivered } = await setup({ answer: new Error("anthropic 529") });
    const res = await post(inbound());
    expect(res.statusCode).toBe(200);
    expect(delivered.map((d) => d.text)).toEqual([SORRY_TEXT]);
    await post(inbound());
    expect(asked).toHaveLength(1);
  });

  it("even if the apology can't be sent, returns 200", async () => {
    const { post } = await setup({ answer: new Error("x"), failDeliver: true });
    expect((await post(inbound())).statusCode).toBe(200);
  });

  it("a malformed body is acknowledged without processing", async () => {
    const { post, asked } = await setup();
    const res = await post({ hello: "world" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false });
    expect(asked).toHaveLength(0);
  });
});
