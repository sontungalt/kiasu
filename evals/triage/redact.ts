import type { ParsedEmail } from "../../src/types.js";

const URL_QUERY = /(https?:\/\/[^\s?#<>"')\]]+)[?#][^\s<>"')\]]*/g;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const NRIC = /\b[STFGM]\d{7}[A-Z]\b/gi;
const SG_PHONE = /(?:\+65[\s-]?)?\b[3689]\d{3}[\s-]?\d{4}\b/g;
const LONG_NUMBER = /\b\d{9,}\b/g;

/** First-pass automatic redaction. Names and addresses still need a manual pass (see README). */
export function redactText(s: string): string {
  return s
    .replace(URL_QUERY, "$1?[redacted]")
    .replace(EMAIL, "redacted@$1")
    .replace(NRIC, "[NRIC]")
    .replace(SG_PHONE, "[PHONE]")
    .replace(LONG_NUMBER, "[NUMBER]");
}

export function redactParsed(p: ParsedEmail): ParsedEmail {
  return {
    ...p,
    from: redactText(p.from),
    to: redactText(p.to),
    subject: redactText(p.subject),
    text: redactText(p.text),
    attachments: p.attachments.map(redactText),
  };
}
