import { describe, it, expect } from "vitest";
import {
  extractAnnouncement, buildAnnouncementContent, normaliseModelDate, MAX_ANNOUNCEMENT_CHARS,
} from "../../src/classroom/announcement.js";
import { makeTestDeps } from "../helpers/deps.js";
import { fakeAnthropic, jsonReply } from "./fake-anthropic.js";

const NOW = new Date("2026-10-14T00:00:00Z"); // Wed 14 Oct, 08:00 SGT
const INPUT = {
  id: "a1",
  courseName: "S3 Chemistry",
  text: "Chem test moved to Friday 16 Oct, bring a calculator.",
  postedAt: "2026-10-13T07:00:00.000Z", // Tue 13 Oct, 15:00 SGT
};

describe("extractAnnouncement", () => {
  it("sends one structured-output call on the triage model and normalises the result", async () => {
    const fake = fakeAnthropic(() => jsonReply({
      title: "Chem test moved to Fri",
      summary: "Test is now Fri 16 Oct; bring a calculator.",
      dueAt: "2026-10-16T08:00:00+08:00",
      urgency: "urgent",
      urgencyReason: "schedule changed",
    }));
    const out = await extractAnnouncement(makeTestDeps({ anthropic: fake.client }), INPUT, NOW);
    expect(out).toEqual({
      title: "Chem test moved to Fri",
      summary: "Test is now Fri 16 Oct; bring a calculator.",
      dueAt: "2026-10-16T00:00:00.000Z",
      urgency: "urgent",
      urgencyReason: "schedule changed",
    });
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(req).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 4000 });
    expect(req.system).toEqual([expect.objectContaining({ type: "text", cache_control: { type: "ephemeral" } })]);
    expect(req.output_config).toMatchObject({ effort: "medium" });
    expect(req.output_config.format).toBeDefined();
    const content = req.messages[0].content as string;
    expect(content).toContain("Class: S3 Chemistry");
    expect(content).toContain("Posted: Tue 13 Oct, 3pm (2026-10-13T15:00:00+08:00)");
    expect(content).toContain("Current time: Wed 14 Oct, 8am (2026-10-14T08:00:00+08:00)");
    expect(content).toContain(INPUT.text);
  });

  it("drops urgencyReason unless urgent", async () => {
    const fake = fakeAnthropic(() => jsonReply({
      title: "Lab coats", summary: "Bring lab coats.", dueAt: null, urgency: "normal", urgencyReason: "because",
    }));
    const out = await extractAnnouncement(makeTestDeps({ anthropic: fake.client }), INPUT, NOW);
    expect(out).toMatchObject({ urgency: "normal", urgencyReason: null, dueAt: null });
  });

  it("returns null on a refusal", async () => {
    const fake = fakeAnthropic(() => ({ text: "", stopReason: "refusal" }));
    expect(await extractAnnouncement(makeTestDeps({ anthropic: fake.client }), INPUT, NOW)).toBeNull();
  });

  it("enforces the urgency enum in the schema sent to the API", async () => {
    const fake = fakeAnthropic(() => jsonReply({ title: "t", summary: "s", dueAt: null, urgency: "low", urgencyReason: null }));
    await extractAnnouncement(makeTestDeps({ anthropic: fake.client }), INPUT, NOW);
    const schema = fake.requests[0]!.output_config.format;
    expect(schema.type).toBe("json_schema");
    expect(schema.schema.properties.urgency.enum).toEqual(["urgent", "normal", "low"]);
  });

  it("returns null on a refusal written as prose", async () => {
    const fake = fakeAnthropic(() => ({ text: "I can't help with that.", stopReason: "refusal" }));
    expect(await extractAnnouncement(makeTestDeps({ anthropic: fake.client }), INPUT, NOW)).toBeNull();
  });

  it("returns null when the output is not valid for the schema", async () => {
    const fake = fakeAnthropic(() => jsonReply({ title: "t", summary: "s", dueAt: null, urgency: "panic", urgencyReason: null }));
    expect(await extractAnnouncement(makeTestDeps({ anthropic: fake.client }), INPUT, NOW)).toBeNull();
  });

  it("returns null when the API errors", async () => {
    const fake = fakeAnthropic(() => ({ httpStatus: 500 }));
    expect(await extractAnnouncement(makeTestDeps({ anthropic: fake.client }), INPUT, NOW)).toBeNull();
  });

  it("truncates very long announcements and says so", () => {
    const content = buildAnnouncementContent({ ...INPUT, text: "y".repeat(MAX_ANNOUNCEMENT_CHARS + 500) }, NOW);
    expect(content).toContain(`cut at ${MAX_ANNOUNCEMENT_CHARS} characters`);
    expect(content.length).toBeLessThan(MAX_ANNOUNCEMENT_CHARS + 400);
  });
});

describe("normaliseModelDate", () => {
  it("reads date-only and offset-less values as Singapore time", () => {
    expect(normaliseModelDate("2026-10-16")).toBe("2026-10-16T15:59:00.000Z");
    expect(normaliseModelDate("2026-10-16T09:00:00")).toBe("2026-10-16T01:00:00.000Z");
    expect(normaliseModelDate("2026-10-16T09:00:00+08:00")).toBe("2026-10-16T01:00:00.000Z");
    expect(normaliseModelDate("not a date")).toBeNull();
    expect(normaliseModelDate(null)).toBeNull();
  });
});
