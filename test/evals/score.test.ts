import { describe, it, expect } from "vitest";
import { scoreTriage, formatReport, type EvalCase, type TriageLabel } from "../../evals/triage/score.js";
import type { TriageItem, TriageResult } from "../../src/triage/triage.js";

const label = (over: Partial<TriageLabel> = {}): TriageLabel => ({
  labelled: true, category: "assignment", importance: "high", expectUrgent: false, deadlines: [], ...over,
});
const item = (over: Partial<TriageItem> = {}): TriageItem => ({
  type: "deadline", title: "Submit English essay", details: null, dueAt: null, startAt: null, endAt: null,
  urgency: "normal", urgencyReason: null, ...over,
});
const result = (over: Partial<TriageResult> = {}): TriageResult => ({
  summary: "s", category: "assignment", importance: "high", needsReply: false, items: [], ...over,
});
const kase = (over: Partial<EvalCase> = {}): EvalCase => ({
  id: "school-1", subject: "Essay", label: label(), result: result(), error: null, ...over,
});

describe("scoreTriage", () => {
  it("passes when urgent items are caught and due dates match in any offset", () => {
    const r = scoreTriage([kase({
      label: label({ expectUrgent: true, deadlines: [{ match: "essay", dueAt: "2026-10-17T23:59:00+08:00" }] }),
      result: result({ items: [item({ urgency: "urgent", urgencyReason: "due soon", dueAt: "2026-10-17T15:59:00Z" })] }),
    })]);
    expect(r).toMatchObject({ scored: 1, passed: true, missedUrgent: [], wrongDueDates: [] });
    expect(r.category).toMatchObject({ correct: 1, total: 1 });
  });

  it("a missed urgent item fails the run", () => {
    const r = scoreTriage([kase({ label: label({ expectUrgent: true }), result: result({ items: [item()] }) })]);
    expect(r.missedUrgent).toEqual([{ id: "school-1", subject: "Essay" }]);
    expect(r.passed).toBe(false);
  });

  it("lists wrong and missing due dates", () => {
    const r = scoreTriage([
      kase({
        id: "a",
        label: label({ deadlines: [{ match: "essay", dueAt: "2026-10-17T23:59:00+08:00" }] }),
        result: result({ items: [item({ dueAt: "2026-10-18T23:59:00+08:00" })] }),
      }),
      kase({ id: "b", label: label({ deadlines: [{ match: "form", dueAt: "2026-10-17T15:00:00+08:00" }] }) }),
    ]);
    expect(r.wrongDueDates.map((w) => [w.id, w.got])).toEqual([["a", "2026-10-18T23:59:00+08:00"], ["b", null]]);
    expect(r.passed).toBe(false);
  });

  it("triage errors count as misses and are listed", () => {
    const r = scoreTriage([kase({
      label: label({ expectUrgent: true, deadlines: [{ match: "essay", dueAt: "2026-10-17T23:59:00+08:00" }] }),
      result: null,
      error: "TriageRefusedError: The model refused to triage this email",
    })]);
    expect(r.failures).toHaveLength(1);
    expect(r.missedUrgent).toHaveLength(1);
    expect(r.wrongDueDates).toHaveLength(1);
    expect(r.category).toMatchObject({ correct: 0, total: 1 });
  });

  it("false alarms are reported but don't fail; unlabelled cases are skipped", () => {
    const r = scoreTriage([
      kase({ result: result({ items: [item({ urgency: "urgent", urgencyReason: "x" })] }) }),
      kase({ id: "todo", label: label({ labelled: false, expectUrgent: true }) }),
    ]);
    expect(r.extraUrgent).toHaveLength(1);
    expect(r.scored).toBe(1);
    expect(r.passed).toBe(true);
  });

  it("formatReport shows the verdict and the pass-bar counts", () => {
    const text = formatReport(scoreTriage([kase({ label: label({ expectUrgent: true }) })]));
    expect(text).toContain("FAIL");
    expect(text).toContain("Missed urgent: 1 (pass bar: 0)");
    expect(text).toContain("Wrong due dates: 0 (pass bar: 0)");
  });
});
