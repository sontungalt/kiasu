import { describe, it, expect } from "vitest";
import { TriageSchema, TRIAGE_JSON_SCHEMA, CATEGORIES, toStructuredOutputSchema } from "../../src/triage/schema.js";

const SAMPLE = {
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

describe("TriageSchema", () => {
  it("accepts a spec-shaped result", () => {
    expect(TriageSchema.parse(SAMPLE)).toEqual(SAMPLE);
  });

  it("rejects an unknown category", () => {
    expect(TriageSchema.safeParse({ ...SAMPLE, category: "homework" }).success).toBe(false);
  });
});

describe("TRIAGE_JSON_SCHEMA", () => {
  it("keeps enums, uses anyOf for nullables, and closes every object", () => {
    const s = TRIAGE_JSON_SCHEMA as any;
    expect(s.$schema).toBeUndefined();
    expect(s.properties.category.enum).toEqual([...CATEGORIES]);
    const item = s.properties.items.items;
    expect(item.properties.urgency.enum).toEqual(["urgent", "normal", "low"]);
    expect(item.properties.dueAt.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
    const objects: any[] = [];
    const walk = (n: any): void => {
      if (n && typeof n === "object") {
        if (n.type === "object") objects.push(n);
        Object.values(n).forEach(walk);
      }
    };
    walk(s);
    expect(objects).toHaveLength(2);
    for (const o of objects) {
      expect(o.additionalProperties).toBe(false);
      expect([...o.required].sort()).toEqual(Object.keys(o.properties).sort());
    }
    expect(JSON.stringify(s)).not.toContain('"type":["');
  });

  it("toStructuredOutputSchema refuses type arrays mixed with other keywords", () => {
    expect(() => toStructuredOutputSchema({ type: ["string", "null"], enum: ["a", null] })).toThrow(/type array/);
  });
});
