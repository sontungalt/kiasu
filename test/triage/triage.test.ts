import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  triageEmail, normaliseIso, TriageRefusedError, TriageParseError, TRIAGE_MAX_TOKENS,
} from "../../src/triage/triage.js";
import type { ParsedEmail } from "../../src/types.js";

const NOW = new Date("2026-10-14T00:05:00Z");
const PARSED: ParsedEmail = {
  id: "m1", account: "school", threadId: "t1", from: "Mr Tan <tan@school.edu.sg>", to: "me@students.school.edu.sg",
  subject: "CCA consent form", date: "2026-10-14T00:00:00.000Z", text: "Please submit by tomorrow 3pm.",
  attachments: [], labelIds: ["INBOX"], truncated: false,
};
const GOOD = {
  summary: "Mr Tan: submit the CCA consent form by Thu 3pm.",
  category: "school_admin",
  importance: "high",
  needsReply: false,
  items: [{
    type: "deadline", title: "Submit CCA consent form", details: null,
    dueAt: "2026-10-15T15:00:00+08:00", startAt: null, endAt: null,
    urgency: "urgent", urgencyReason: "Due within 36 hours",
  }],
};

/** A real Anthropic client whose fetch returns canned Messages API JSON. No network. */
function cannedAnthropic(reply: { status?: number; json: unknown }) {
  const requests: Array<Record<string, any>> = [];
  const anthropic = new Anthropic({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(reply.json), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { anthropic, requests };
}

function apiMessage(content: unknown[], stop_reason = "end_turn") {
  return {
    id: "msg_test", type: "message", role: "assistant", model: "claude-haiku-5-5",
    content, stop_reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 },
  };
}
const textBlock = (text: string) => ({ type: "text", text });
const run = (anthropic: Anthropic) => triageEmail(anthropic, "claude-haiku-5-5", PARSED, "school", NOW);

describe("triageEmail", () => {
  it("returns the parsed result and sends the expected request", async () => {
    const { anthropic, requests } = cannedAnthropic({
      json: apiMessage([{ type: "thinking", thinking: "…", signature: "sig" }, textBlock(JSON.stringify(GOOD))]),
    });
    expect(await run(anthropic)).toEqual(GOOD);
    const req = requests[0]!;
    expect(req.model).toBe("claude-haiku-5-5");
    expect(req.max_tokens).toBe(TRIAGE_MAX_TOKENS);
    expect(req.system[0]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
    expect(req.output_config).toMatchObject({ effort: "medium", format: { type: "json_schema" } });
    expect(req.output_config.format.schema.properties.category.enum).toContain("exam_test");
    expect(req).not.toHaveProperty("thinking");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[0].content).toContain("<email>");
  });

  it("refusal throws TriageRefusedError", async () => {
    const { anthropic } = cannedAnthropic({ json: apiMessage([textBlock("I can't help with that.")], "refusal") });
    await expect(run(anthropic)).rejects.toBeInstanceOf(TriageRefusedError);
  });

  it("non-JSON text throws TriageParseError", async () => {
    const { anthropic } = cannedAnthropic({ json: apiMessage([textBlock("Sorry, here is a summary instead.")]) });
    await expect(run(anthropic)).rejects.toBeInstanceOf(TriageParseError);
  });

  it("JSON that breaks the schema throws TriageParseError", async () => {
    const { anthropic } = cannedAnthropic({ json: apiMessage([textBlock(JSON.stringify({ ...GOOD, category: "homework" }))]) });
    await expect(run(anthropic)).rejects.toBeInstanceOf(TriageParseError);
  });

  it("max_tokens throws TriageParseError", async () => {
    const { anthropic } = cannedAnthropic({ json: apiMessage([textBlock('{"summary": "Mr')], "max_tokens") });
    await expect(run(anthropic)).rejects.toBeInstanceOf(TriageParseError);
  });

  it("HTTP errors surface as Anthropic.APIError (retryable), not as triage errors", async () => {
    const { anthropic } = cannedAnthropic({ status: 500, json: { type: "error", error: { type: "api_error", message: "boom" } } });
    const err = await run(anthropic).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.APIError);
    expect(err).not.toBeInstanceOf(TriageParseError);
  });

  it("normalises the summary, date-only due dates and missing urgency reasons", async () => {
    const raw = {
      ...GOOD,
      summary: "x".repeat(250),
      items: [{ ...GOOD.items[0], dueAt: "2026-10-17", urgencyReason: null }],
    };
    const { anthropic } = cannedAnthropic({ json: apiMessage([textBlock(JSON.stringify(raw))]) });
    const r = await run(anthropic);
    expect(r.summary).toHaveLength(200);
    expect(r.summary.endsWith("…")).toBe(true);
    expect(r.items[0]).toMatchObject({ dueAt: "2026-10-17T23:59:00+08:00", urgencyReason: "Marked urgent by triage" });
  });
});

describe("normaliseIso", () => {
  it("fills missing times and offsets in SGT and drops non-dates", () => {
    expect(normaliseIso("2026-10-17", "due")).toBe("2026-10-17T23:59:00+08:00");
    expect(normaliseIso("2026-10-17", "start")).toBe("2026-10-17T00:00:00+08:00");
    expect(normaliseIso("2026-10-17T09:00", "start")).toBe("2026-10-17T09:00+08:00");
    expect(normaliseIso("2026-10-17T09:00:00Z", "due")).toBe("2026-10-17T09:00:00Z");
    expect(normaliseIso("next Friday", "due")).toBeNull();
    expect(normaliseIso("", "due")).toBeNull();
    expect(normaliseIso(null, "due")).toBeNull();
  });
});
