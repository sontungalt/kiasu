import { z } from "zod";
import type { EmailCategory } from "../types.js";

export const CATEGORIES = [
  "assignment", "exam_test", "teacher_message", "school_admin", "cca",
  "event", "personal", "finance_receipt", "account_security",
  "newsletter", "promotion", "other",
] as const satisfies readonly EmailCategory[];

// Compile-time check that CATEGORIES lists every EmailCategory.
type MissingCategory = Exclude<EmailCategory, (typeof CATEGORIES)[number]>;
const allCategoriesListed: [MissingCategory] extends [never] ? true : never = true;
void allCategoriesListed;

const isoOrNull = (what: string) =>
  z.string().nullable().describe(
    `${what} as ISO 8601 with the +08:00 offset, e.g. 2026-10-17T23:59:00+08:00. null if the email does not state one.`,
  );

export const TriageItemSchema = z.object({
  type: z.enum(["task", "deadline", "event", "info"]),
  title: z.string().describe('Short and actionable, at most about 8 words, e.g. "Submit CCA consent form"'),
  details: z.string().nullable().describe("One or two sentences of specifics, or null"),
  dueAt: isoOrNull("Deadline"),
  startAt: isoOrNull("Event start"),
  endAt: isoOrNull("Event end"),
  urgency: z.enum(["urgent", "normal", "low"]),
  urgencyReason: z.string().nullable().describe("Why it is urgent. Required when urgency is urgent, otherwise null"),
});

export const TriageSchema = z.object({
  summary: z.string().describe("One sentence, at most 200 characters"),
  category: z.enum(CATEGORIES),
  importance: z.enum(["high", "medium", "low"]),
  needsReply: z.boolean(),
  items: z.array(TriageItemSchema),
});

export type TriageResult = z.infer<typeof TriageSchema>;
export type TriageItem = z.infer<typeof TriageItemSchema>;

type JsonObject = { [key: string]: unknown };

/**
 * Makes z.toJSONSchema() output fit structured outputs: drops `$schema` and rewrites nullable
 * type arrays (`type: ["string","null"]`) as `anyOf`. Enums are kept, unlike the SDK's zodOutputFormat helper.
 */
export function toStructuredOutputSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStructuredOutputSchema);
  if (node === null || typeof node !== "object") return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    out[key] = toStructuredOutputSchema(value);
  }
  if (Array.isArray(out.type)) {
    const { type, ...rest } = out;
    const extra = Object.keys(rest).filter((k) => k !== "description");
    if (extra.length > 0) throw new Error(`Cannot convert a type array combined with ${extra.join(", ")}`);
    return { ...rest, anyOf: (type as unknown[]).map((t) => ({ type: t })) };
  }
  return out;
}

export const TRIAGE_JSON_SCHEMA = toStructuredOutputSchema(z.toJSONSchema(TriageSchema)) as JsonObject;
