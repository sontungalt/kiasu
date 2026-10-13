import type Anthropic from "@anthropic-ai/sdk";
import type { AccountId, ParsedEmail } from "../types.js";
import { SYSTEM_PROMPT, buildTriageInput } from "./prompt.js";
import { TRIAGE_JSON_SCHEMA, TriageSchema, type TriageResult } from "./schema.js";

export { TriageSchema } from "./schema.js";
export type { TriageResult, TriageItem } from "./schema.js";

export type TriageFn = (parsed: ParsedEmail, account: AccountId, now: Date) => Promise<TriageResult>;

export const TRIAGE_MAX_TOKENS = 8000;
const SUMMARY_MAX = 200;

/** stop_reason "refusal": mark the email failed straight away. */
export class TriageRefusedError extends Error {
  constructor() {
    super("The model refused to triage this email");
    this.name = "TriageRefusedError";
  }
}

/** Output we can't use. Retryable. The message never contains model output or email text. */
export class TriageParseError extends Error {
  constructor(reason: string) {
    super(`Triage output unusable: ${reason}`);
    this.name = "TriageParseError";
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/** Accepts the model's date string, filling a missing time (23:59 for due, 00:00 for start/end) or offset (+08:00). Non-dates become null. */
export function normaliseIso(value: string | null, kind: "due" | "start"): string | null {
  if (!value) return null;
  let v = value.trim();
  if (DATE_ONLY.test(v)) v = `${v}T${kind === "due" ? "23:59:00" : "00:00:00"}+08:00`;
  else if (LOCAL_DATETIME.test(v)) v = `${v}+08:00`;
  if (!HAS_OFFSET.test(v)) return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

export function normaliseTriage(raw: TriageResult): TriageResult {
  const summary = raw.summary.trim();
  return {
    ...raw,
    summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary,
    items: raw.items
      .filter((i) => i.title.trim() !== "")
      .map((i) => ({
        ...i,
        title: i.title.trim().slice(0, 120),
        details: i.details?.trim() || null,
        dueAt: normaliseIso(i.dueAt, "due"),
        startAt: normaliseIso(i.startAt, "start"),
        endAt: normaliseIso(i.endAt, "start"),
        urgencyReason: i.urgency === "urgent"
          ? i.urgencyReason?.trim() || "Marked urgent by triage"
          : i.urgencyReason?.trim() || null,
      })),
  };
}

/**
 * One Haiku call with structured output. Uses messages.create rather than messages.parse because,
 * in SDK 0.133, zodOutputFormat drops enum constraints and parse() throws on a prose refusal
 * before stop_reason can be checked.
 */
export async function triageEmail(
  anthropic: Anthropic,
  model: string,
  parsed: ParsedEmail,
  account: AccountId,
  now: Date,
): Promise<TriageResult> {
  const res = await anthropic.messages.create({
    model,
    max_tokens: TRIAGE_MAX_TOKENS,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildTriageInput(parsed, account, now) }],
    output_config: { format: { type: "json_schema", schema: TRIAGE_JSON_SCHEMA }, effort: "medium" },
  });

  if (res.stop_reason === "refusal") throw new TriageRefusedError();
  if (res.stop_reason === "max_tokens") throw new TriageParseError("hit max_tokens");
  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (!text) throw new TriageParseError("no text block");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new TriageParseError("invalid JSON");
  }
  const result = TriageSchema.safeParse(json);
  if (!result.success) {
    throw new TriageParseError(`schema mismatch at ${result.error.issues[0]?.path.join(".") || "(root)"}`);
  }
  return normaliseTriage(result.data);
}
