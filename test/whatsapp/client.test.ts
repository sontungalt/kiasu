import { describe, it, expect } from "vitest";
import { createWhatsAppClient, isWindowClosedError, sanitiseTemplateParam, WhatsAppError } from "../../src/whatsapp/client.js";
import { loadConfig } from "../../src/config.js";
import { TEST_ENV } from "../helpers/env.js";

interface Call { url: string; init: RequestInit; body: Record<string, unknown> }

/** A fetch stand-in. Each call consumes the next queued response; the default is a success. */
function fakeFetch(responses: Array<{ status: number; body: unknown } | Error> = []) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) as Record<string, unknown> });
    const next = responses.shift() ?? { status: 200, body: { messaging_product: "whatsapp", messages: [{ id: `wamid.${calls.length}` }] } };
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { impl, calls };
}

const config = loadConfig(TEST_ENV);

const REENGAGEMENT_BODY = {
  error: {
    message: "(#131047) Re-engagement message",
    type: "OAuthException",
    code: 131047,
    error_data: { messaging_product: "whatsapp", details: "Message failed to send because more than 24 hours have passed since the customer last replied to this number." },
    fbtrace_id: "Az8or2yhqkZfEZ-_4Qn_Bam",
  },
};

describe("createWhatsAppClient", () => {
  it("sendText posts a text message to my number with the bearer token", async () => {
    const f = fakeFetch();
    const res = await createWhatsAppClient(config, f.impl).sendText("hi");
    expect(res).toEqual({ messageId: "wamid.1" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://graph.facebook.com/v23.0/123456/messages");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer wa-token");
    expect(f.calls[0]!.body).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: "6500000000",
      type: "text", text: { body: "hi", preview_url: false },
    });
  });

  it("splits long text into several sends and returns the last id", async () => {
    const f = fakeFetch();
    const text = Array.from({ length: 50 }, () => "p".repeat(100)).join("\n\n");
    const res = await createWhatsAppClient(config, f.impl).sendText(text);
    expect(f.calls).toHaveLength(2);
    expect(res.messageId).toBe("wamid.2");
  });

  it("refuses to send empty text", async () => {
    const f = fakeFetch();
    await expect(createWhatsAppClient(config, f.impl).sendText("  \n ")).rejects.toBeInstanceOf(WhatsAppError);
    expect(f.calls).toHaveLength(0);
  });

  it("sendTemplate sends language en with positional body parameters and no button component", async () => {
    const f = fakeFetch();
    await createWhatsAppClient(config, f.impl).sendTemplate({ name: "brief_ready", params: ["morning", "2", "1"] });
    expect(f.calls[0]!.body).toMatchObject({ to: "6500000000", type: "template" });
    expect(f.calls[0]!.body.template).toEqual({
      name: "brief_ready",
      language: { code: "en" },
      components: [{ type: "body", parameters: [
        { type: "text", text: "morning" }, { type: "text", text: "2" }, { type: "text", text: "1" },
      ] }],
    });
  });

  it("sanitises template parameters (no newlines/tabs/long space runs, never empty)", async () => {
    expect(sanitiseTemplateParam("Line one\n\tline     two ")).toBe("Line one line two");
    expect(sanitiseTemplateParam("   ")).toBe("-");
    const long = sanitiseTemplateParam("😀".repeat(400));
    expect(Array.from(long)).toHaveLength(300);
    expect(long.endsWith("…")).toBe(true);
    const f = fakeFetch();
    await createWhatsAppClient(config, f.impl).sendTemplate({ name: "heads_up", params: ["Test moved\nto Friday"] });
    expect(f.calls[0]!.body.template).toMatchObject({ components: [{ parameters: [{ type: "text", text: "Test moved to Friday" }] }] });
  });

  it("maps a Graph error to WhatsAppError with status and code", async () => {
    const f = fakeFetch([{ status: 400, body: REENGAGEMENT_BODY }]);
    const err = await createWhatsAppClient(config, f.impl).sendText("hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhatsAppError);
    expect(err).toMatchObject({ name: "WhatsAppError", status: 400, code: 131047 });
    expect((err as Error).message).toContain("131047");
    expect(isWindowClosedError(err)).toBe(true);
  });

  it("handles non-JSON error bodies and network failures", async () => {
    const f = fakeFetch([{ status: 502, body: "<html>Bad Gateway</html>" }, new TypeError("fetch failed")]);
    const client = createWhatsAppClient(config, f.impl);
    await expect(client.sendText("hi")).rejects.toMatchObject({ status: 502, code: null });
    await expect(client.sendText("hi")).rejects.toMatchObject({ status: 0, code: null });
    expect(isWindowClosedError(new WhatsAppError(400, 131026, "x"))).toBe(false);
  });

  it("rejects a 200 response without a message id", async () => {
    const f = fakeFetch([{ status: 200, body: { messaging_product: "whatsapp" } }]);
    await expect(createWhatsAppClient(config, f.impl).sendText("hi")).rejects.toThrow(/no message id/);
  });
});
