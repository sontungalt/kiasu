import { describe, it, expect, beforeEach } from "vitest";
import { createOutbox, MAX_SEND_ATTEMPTS, TEMPLATE_FAILED } from "../../src/whatsapp/outbox.js";
import { WhatsAppError } from "../../src/whatsapp/client.js";
import type { OutboundMessage, WhatsAppClient } from "../../src/ports.js";
import type { TemplateRef } from "../../src/types.js";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";

const MIN = 60_000;

/** Records every send. Errors pushed onto `failures` are thrown by the next calls, in order. */
function fakeWhatsApp(opts: { delayMs?: number } = {}) {
  const sent: string[] = []; // "text:<body>" or "template:<name>"
  const failures: Error[] = [];
  const pause = () => (opts.delayMs ? new Promise((r) => setTimeout(r, opts.delayMs)) : Promise.resolve());
  const client: WhatsAppClient = {
    async sendText(text: string) {
      await pause();
      const f = failures.shift();
      if (f) throw f;
      sent.push(`text:${text}`);
      return { messageId: `wamid.${sent.length}` };
    },
    async sendTemplate(t: TemplateRef) {
      await pause();
      const f = failures.shift();
      if (f) throw f;
      sent.push(`template:${t.name}`);
      return { messageId: `wamid.${sent.length}` };
    },
  };
  return { client, sent, failures };
}

const msg = (text: string, template: TemplateRef = { name: "heads_up", params: [text] }): OutboundMessage =>
  ({ kind: "alert", text, template });

const serverError = () => new WhatsAppError(500, 1, "WhatsApp API error 1 (HTTP 500): temporary");
const reengagement = () => new WhatsAppError(400, 131047, "WhatsApp API error 131047 (HTTP 400): re-engagement");

async function openWindow(deps: TestDeps, agoMs = MIN) {
  await deps.store.state.set("whatsapp", { lastInboundAt: new Date(deps.clock.now().getTime() - agoMs).toISOString() });
}

describe("outbox", () => {
  let deps: TestDeps;
  let wa: ReturnType<typeof fakeWhatsApp>;

  beforeEach(() => {
    wa = fakeWhatsApp();
    deps = makeTestDeps({ whatsapp: wa.client });
  });

  it("window open: sends free text and records it as sent", async () => {
    await openWindow(deps);
    expect(await createOutbox(deps).deliver(msg("Mrs Tan moved the test"))).toBe("sent");
    expect(wa.sent).toEqual(["text:Mrs Tan moved the test"]);
    expect(await deps.store.outbox.listPending()).toEqual([]);
  });

  it("window closed: stores the message pending and sends its template", async () => {
    const outbox = createOutbox(deps);
    expect(await outbox.deliver({ kind: "morning", text: "*Good morning!*", template: { name: "brief_ready", params: ["morning", "2", "1"] } })).toBe("queued");
    expect(wa.sent).toEqual(["template:brief_ready"]);
    const pending = await deps.store.outbox.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "morning", text: "*Good morning!*", status: "pending", attempts: 0 });
  });

  it("sends at most one template per 10-minute bucket", async () => {
    const outbox = createOutbox(deps); // clock at 00:00:00Z, a bucket boundary
    await outbox.deliver(msg("one"));
    deps.clock.advance(5 * MIN);
    await outbox.deliver(msg("two"));
    expect(wa.sent).toEqual(["template:heads_up"]);
    deps.clock.advance(6 * MIN); // 00:11, next bucket
    await outbox.deliver(msg("three"));
    expect(wa.sent).toEqual(["template:heads_up", "template:heads_up"]);
    expect(await deps.store.outbox.listPending()).toHaveLength(3);
  });

  it("flush sends every pending message oldest-first once the window opens", async () => {
    const outbox = createOutbox(deps);
    await outbox.deliver(msg("first"));
    await outbox.deliver(msg("second"));
    expect(await outbox.flush()).toBe(0); // still closed
    await openWindow(deps);
    expect(await outbox.flush()).toBe(2);
    expect(wa.sent.filter((s) => s.startsWith("text:"))).toEqual(["text:first", "text:second"]);
    expect(await deps.store.outbox.listPending()).toEqual([]);
    expect(await outbox.flush()).toBe(0);
  });

  it("a failed send stays pending with attempts/lastError and flush retries it", async () => {
    await openWindow(deps);
    const outbox = createOutbox(deps);
    wa.failures.push(serverError());
    expect(await outbox.deliver(msg("retry me"))).toBe("queued");
    const [pending] = await deps.store.outbox.listPending();
    expect(pending).toMatchObject({ status: "pending", attempts: 1 });
    expect(pending!.lastError).toContain("HTTP 500");
    expect(wa.sent).toEqual([]); // no template: the window is open
    expect(await outbox.flush()).toBe(1);
    expect(wa.sent).toEqual(["text:retry me"]);
  });

  it(`marks a message failed after ${MAX_SEND_ATTEMPTS} attempts and moves on`, async () => {
    await openWindow(deps);
    const outbox = createOutbox(deps);
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) wa.failures.push(serverError());
    await outbox.deliver(msg("doomed"));
    for (let i = 1; i < MAX_SEND_ATTEMPTS; i++) await outbox.flush();
    expect(await deps.store.outbox.listPending()).toEqual([]);
    expect(await outbox.deliver(msg("next"))).toBe("sent");
    expect(wa.sent).toEqual(["text:next"]);
  });

  it("flush stops at the first failure and keeps order", async () => {
    const outbox = createOutbox(deps);
    for (const t of ["a", "b", "c"]) await outbox.deliver(msg(t));
    await openWindow(deps);
    wa.failures.push(serverError());
    expect(await outbox.flush()).toBe(0);
    expect(await outbox.flush()).toBe(3);
    expect(wa.sent.filter((s) => s.startsWith("text:"))).toEqual(["text:a", "text:b", "text:c"]);
  });

  it("window closes between the check and the send (131047): queues and sends the template", async () => {
    await openWindow(deps, 24 * 60 * MIN - 6 * MIN); // our check says open, Meta disagrees
    const outbox = createOutbox(deps);
    wa.failures.push(reengagement());
    expect(await outbox.deliver(msg("late alert"))).toBe("queued");
    expect(wa.sent).toEqual(["template:heads_up"]);
    const [pending] = await deps.store.outbox.listPending();
    expect(pending).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("a failed template is retried by a later flush while the window stays closed", async () => {
    const outbox = createOutbox(deps);
    wa.failures.push(new WhatsAppError(400, 132001, "template missing"));
    await outbox.deliver(msg("alert"));
    expect((await deps.store.outbox.listPending())[0]!.lastError).toMatch(new RegExp(`^${TEMPLATE_FAILED}`));
    expect(await outbox.flush()).toBe(0); // same bucket: suppressed
    expect(wa.sent).toEqual([]);
    deps.clock.advance(10 * MIN);
    await outbox.flush();
    expect(wa.sent).toEqual(["template:heads_up"]);
    expect((await deps.store.outbox.listPending())[0]!.lastError).toBeNull();
    await outbox.flush(); // nothing flagged any more: no template spam
    deps.clock.advance(10 * MIN);
    await outbox.flush();
    expect(wa.sent).toEqual(["template:heads_up"]);
  });

  it("two concurrent flushes (two instances) send each message exactly once", async () => {
    const slow = fakeWhatsApp({ delayMs: 5 });
    const d = makeTestDeps({ whatsapp: slow.client });
    const a = createOutbox(d);
    const b = createOutbox(d);
    for (const t of ["1", "2", "3"]) await a.deliver(msg(t));
    await openWindow(d);
    const counts = await Promise.all([a.flush(), b.flush()]);
    expect(counts[0] + counts[1]).toBe(3);
    expect(slow.sent.filter((s) => s.startsWith("text:"))).toEqual(["text:1", "text:2", "text:3"]);
  });

  it("a deliver racing a flush in the same process keeps order and sends once", async () => {
    const slow = fakeWhatsApp({ delayMs: 5 });
    const d = makeTestDeps({ whatsapp: slow.client });
    const outbox = createOutbox(d);
    await outbox.deliver(msg("old1"));
    await outbox.deliver(msg("old2"));
    await openWindow(d);
    const [delivered, flushed] = await Promise.all([outbox.deliver(msg("new")), outbox.flush()]);
    expect(delivered).toBe("sent");
    expect(flushed).toBe(0);
    expect(slow.sent.filter((s) => s.startsWith("text:"))).toEqual(["text:old1", "text:old2", "text:new"]);
  });

  it("a send claim left by a crashed instance expires after its bucket", async () => {
    const outbox = createOutbox(deps);
    await outbox.deliver(msg("stuck"));
    const [m] = await deps.store.outbox.listPending();
    const bucket = Math.floor(deps.clock.now().getTime() / (10 * MIN));
    await deps.store.processed.claim(`wa:out:${m!.id}:0:${bucket}`, deps.clock.now().toISOString());
    await openWindow(deps);
    expect(await outbox.flush()).toBe(0);
    deps.clock.advance(10 * MIN);
    await openWindow(deps);
    expect(await outbox.flush()).toBe(1);
  });
});

describe("outbox with alwaysOpen (Telegram: no 24h window)", () => {
  let deps: TestDeps;
  let wa: ReturnType<typeof fakeWhatsApp>;

  beforeEach(() => {
    wa = fakeWhatsApp();
    deps = makeTestDeps({ whatsapp: wa.client });
  });

  it("sends free text even though I never messaged, and never sends a template", async () => {
    const outbox = createOutbox(deps, { alwaysOpen: true });
    expect(await outbox.deliver(msg("Good morning!", { name: "brief_ready", params: ["morning", "1", "0"] }))).toBe("sent");
    expect(wa.sent).toEqual(["text:Good morning!"]);
    expect(await deps.store.state.get("whatsapp")).toBeNull();
  });

  it("a failed send stays pending without a template, and the next flush sends it", async () => {
    const outbox = createOutbox(deps, { alwaysOpen: true });
    wa.failures.push(serverError());
    expect(await outbox.deliver(msg("alert"))).toBe("queued");
    expect(wa.sent).toEqual([]);
    const [pending] = await deps.store.outbox.listPending();
    expect(pending).toMatchObject({ text: "alert", attempts: 1 });
    expect(pending!.lastError?.startsWith(TEMPLATE_FAILED)).toBe(false);
    deps.clock.advance(10 * MIN);
    expect(await outbox.flush()).toBe(1);
    expect(wa.sent).toEqual(["text:alert"]);
  });

  it("without the option the old behaviour holds (window closed: template)", async () => {
    expect(await createOutbox(deps, {}).deliver(msg("x"))).toBe("queued");
    expect(wa.sent).toEqual(["template:heads_up"]);
  });
});
