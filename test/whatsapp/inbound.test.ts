import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  extractWebhook, safeEqual, toInboundMessage, unixToIso, verifyMetaSignature, type WaRawMessage,
} from "../../src/whatsapp/inbound.js";

const SECRET = "wa-secret";
const sign = (raw: string | Buffer) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
const NOW = new Date("2026-10-14T00:00:00Z");

describe("verifyMetaSignature", () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account"}');

  it("accepts the HMAC of the raw body", () => {
    expect(verifyMetaSignature(raw, sign(raw), SECRET)).toBe(true);
    expect(verifyMetaSignature(raw, sign(raw).toUpperCase().replace("SHA256=", "sha256="), SECRET)).toBe(true);
  });

  it("rejects wrong secret, tampered body, missing/malformed/array headers", () => {
    expect(verifyMetaSignature(raw, sign(raw), "other-secret")).toBe(false);
    expect(verifyMetaSignature(Buffer.from('{"object":"x"}'), sign(raw), SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, sign(raw).replace("sha256=", "sha1="), SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, "sha256=abcd", SECRET)).toBe(false); // too short: no timingSafeEqual throw
    expect(verifyMetaSignature(raw, [sign(raw)], SECRET)).toBe(false);
  });

  it("a re-serialised body does not verify (escaped unicode differs from the raw bytes)", () => {
    const rawEscaped = '{"body":"caf\\u00e9 \\ud83d\\ude00"}';
    const header = sign(rawEscaped);
    expect(verifyMetaSignature(Buffer.from(rawEscaped), header, SECRET)).toBe(true);
    const reserialised = JSON.stringify(JSON.parse(rawEscaped)); // '{"body":"café 😀"}'
    expect(verifyMetaSignature(Buffer.from(reserialised), header, SECRET)).toBe(false);
  });
});

describe("safeEqual", () => {
  it("compares strings of any length", () => {
    expect(safeEqual("wa-verify", "wa-verify")).toBe(true);
    expect(safeEqual("wa-verify", "wa-verif")).toBe(false);
  });
});

describe("extractWebhook", () => {
  it("collects messages and statuses across entries and changes, skipping junk", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        { id: "1", changes: [
          { field: "messages", value: { messages: [{ id: "wamid.A", from: "6500000000", timestamp: "1791936000", type: "text", text: { body: "hi" } }] } },
          { field: "messages", value: { statuses: [{ id: "wamid.S", status: "delivered", timestamp: "1791936000", recipient_id: "6500000000" }] } },
        ] },
        { id: "2", changes: [{ field: "messages", value: { messages: [{ id: "wamid.B", from: "6500000000", type: "button", button: { text: "Show me", payload: "Show me" } }, { nope: true }, null] } }] },
        "garbage",
      ],
    };
    const out = extractWebhook(payload);
    expect(out.messages.map((m) => m.id)).toEqual(["wamid.A", "wamid.B"]);
    expect(out.statuses.map((s) => s.id)).toEqual(["wamid.S"]);
  });

  it("returns nothing for non-objects and status-only payloads have no messages", () => {
    expect(extractWebhook(null)).toEqual({ messages: [], statuses: [] });
    expect(extractWebhook({ entry: [{ changes: [{ value: { statuses: [{ id: "x", status: "read" }] } }] }] }).messages).toEqual([]);
  });
});

describe("toInboundMessage", () => {
  const base = { id: "wamid.X", from: "6500000000", timestamp: "1791936000" };

  it("converts unix seconds to UTC ISO", () => {
    expect(unixToIso("1749416383", NOW)).toBe("2025-06-08T20:59:43.000Z");
    expect(unixToIso(undefined, NOW)).toBe(NOW.toISOString());
    expect(unixToIso("abc", NOW)).toBe(NOW.toISOString());
  });

  it("maps text", () => {
    expect(toInboundMessage({ ...base, type: "text", text: { body: "what's due?" } }, NOW)).toEqual({
      id: "wamid.X", from: "6500000000", timestamp: "2026-10-14T00:00:00.000Z",
      type: "text", text: "what's due?", contextMessageId: null,
    });
  });

  it("maps a template quick-reply tap (button) with its context id", () => {
    const m: WaRawMessage = { ...base, type: "button", button: { text: "Show me", payload: "Show me" }, context: { from: "15550000000", id: "wamid.TEMPLATE" } };
    expect(toInboundMessage(m, NOW)).toMatchObject({ type: "button", text: "Show me", contextMessageId: "wamid.TEMPLATE" });
  });

  it("maps interactive button_reply and list_reply titles", () => {
    expect(toInboundMessage({ ...base, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b1", title: "Details" } } }, NOW))
      .toMatchObject({ type: "button", text: "Details" });
    expect(toInboundMessage({ ...base, type: "interactive", interactive: { type: "list_reply", list_reply: { id: "r1", title: "Tomorrow", description: "d" } } }, NOW))
      .toMatchObject({ type: "button", text: "Tomorrow" });
  });

  it("maps anything else to unsupported with null text", () => {
    expect(toInboundMessage({ ...base, type: "image" }, NOW)).toMatchObject({ type: "unsupported", text: null });
    expect(toInboundMessage({ ...base, type: "interactive", interactive: { type: "nfm_reply" } }, NOW)).toMatchObject({ type: "unsupported", text: null });
  });
});
