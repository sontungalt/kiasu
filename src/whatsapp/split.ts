/**
 * WhatsApp's text body limit. Measured in UTF-16 code units (String.length), which is never
 * smaller than the code-point count, so a chunk that fits here also fits Meta's limit.
 */
export const WA_TEXT_LIMIT = 4096;

const SEPARATORS = ["\n\n", "\n", " "];

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Where to cut `window` (the first limit+1 chars of the remaining text). Returns a value in [1, limit]. */
function cutPoint(window: string, limit: number): number {
  // Prefer the latest paragraph break, then line break, then space, in the second half of the window.
  const min = Math.floor(limit / 2);
  for (const sep of SEPARATORS) {
    const i = window.lastIndexOf(sep);
    if (i >= min) return i;
  }
  // Otherwise accept a break anywhere.
  for (const sep of SEPARATORS) {
    const i = window.lastIndexOf(sep);
    if (i > 0) return i;
  }
  // No whitespace at all: hard cut, but never between the two halves of a surrogate pair (emoji).
  let cut = limit;
  if (isHighSurrogate(window.charCodeAt(cut - 1))) cut -= 1;
  return Math.max(1, cut);
}

/** Splits text into chunks of at most `limit` UTF-16 units, on paragraph/line/word boundaries where possible. */
export function splitText(text: string, limit: number = WA_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = cutPoint(rest.slice(0, limit + 1), limit);
    const head = rest.slice(0, cut).trimEnd();
    if (head) chunks.push(head);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
