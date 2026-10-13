import { toUtcIso } from "../../src/lib/clock.js";
import type { EmailCategory, Importance } from "../../src/types.js";
import type { TriageResult } from "../../src/triage/schema.js";

export interface DeadlineLabel {
  match: string; // lowercase words expected in the item title, e.g. "consent form"
  dueAt: string; // ISO with offset, e.g. "2026-10-17T23:59:00+08:00"
}

export interface TriageLabel {
  labelled: boolean;
  category: EmailCategory | null;
  importance: Importance | null;
  expectUrgent: boolean;
  deadlines: DeadlineLabel[];
  notes?: string;
}

export type Labels = Record<string, TriageLabel>;

export interface EvalCase {
  id: string;
  subject: string;
  label: TriageLabel;
  result: TriageResult | null;
  error: string | null;
}

export interface CaseRef {
  id: string;
  subject: string;
}

export interface EvalReport {
  scored: number;
  missedUrgent: CaseRef[];
  extraUrgent: CaseRef[];
  wrongDueDates: Array<CaseRef & { match: string; expected: string; got: string | null }>;
  category: { correct: number; total: number; misses: Array<CaseRef & { expected: string; got: string | null }> };
  importance: { correct: number; total: number };
  failures: Array<CaseRef & { error: string }>;
  passed: boolean;
}

function sameInstant(a: string, b: string): boolean {
  try {
    return toUtcIso(a) === toUtcIso(b);
  } catch {
    return false;
  }
}

export function scoreTriage(cases: EvalCase[]): EvalReport {
  const r: EvalReport = {
    scored: 0, missedUrgent: [], extraUrgent: [], wrongDueDates: [],
    category: { correct: 0, total: 0, misses: [] }, importance: { correct: 0, total: 0 },
    failures: [], passed: false,
  };
  for (const c of cases) {
    if (!c.label.labelled) continue;
    r.scored++;
    const ref: CaseRef = { id: c.id, subject: c.subject };
    const items = c.result?.items ?? [];
    if (c.error !== null) r.failures.push({ ...ref, error: c.error });

    const anyUrgent = items.some((i) => i.urgency === "urgent");
    if (c.label.expectUrgent && !anyUrgent) r.missedUrgent.push(ref);
    if (!c.label.expectUrgent && anyUrgent) r.extraUrgent.push(ref);

    for (const d of c.label.deadlines) {
      const got = items.find((i) => i.title.toLowerCase().includes(d.match.toLowerCase()))?.dueAt ?? null;
      if (!got || !sameInstant(got, d.dueAt)) r.wrongDueDates.push({ ...ref, match: d.match, expected: d.dueAt, got });
    }

    if (c.label.category !== null) {
      r.category.total++;
      if (c.result?.category === c.label.category) r.category.correct++;
      else r.category.misses.push({ ...ref, expected: c.label.category, got: c.result?.category ?? null });
    }
    if (c.label.importance !== null) {
      r.importance.total++;
      if (c.result?.importance === c.label.importance) r.importance.correct++;
    }
  }
  r.passed = r.missedUrgent.length === 0 && r.wrongDueDates.length === 0;
  return r;
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);

export function formatReport(r: EvalReport): string {
  return [
    `Triage eval: ${r.passed ? "PASS" : "FAIL"} (${r.scored} labelled emails)`,
    `  Missed urgent: ${r.missedUrgent.length} (pass bar: 0)`,
    ...r.missedUrgent.map((c) => `    - ${c.id}  ${c.subject}`),
    `  Wrong due dates: ${r.wrongDueDates.length} (pass bar: 0)`,
    ...r.wrongDueDates.map((w) => `    - ${w.id}  "${w.match}": expected ${w.expected}, got ${w.got ?? "nothing"}`),
    `  Category accuracy: ${r.category.correct}/${r.category.total} (${pct(r.category.correct, r.category.total)})`,
    ...r.category.misses.map((m) => `    - ${m.id}  expected ${m.expected}, got ${m.got ?? "error"}`),
    `  Importance accuracy: ${r.importance.correct}/${r.importance.total} (${pct(r.importance.correct, r.importance.total)})`,
    `  Extra urgent (false alarms): ${r.extraUrgent.length}`,
    ...r.extraUrgent.map((c) => `    - ${c.id}  ${c.subject}`),
    `  Triage errors: ${r.failures.length}`,
    ...r.failures.map((f) => `    - ${f.id}  ${f.error}`),
  ].join("\n");
}
