import { describe, it, expect } from "vitest";
import { splitText, WA_TEXT_LIMIT } from "../../src/whatsapp/split.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("splitText", () => {
  it("returns short text unchanged", () => {
    expect(splitText("hello")).toEqual(["hello"]);
    expect(splitText("x".repeat(WA_TEXT_LIMIT))).toHaveLength(1);
  });

  it("prefers paragraph breaks", () => {
    expect(splitText("para one is here\n\npara two", 20)).toEqual(["para one is here", "para two"]);
  });

  it("falls back to line breaks, then spaces", () => {
    expect(splitText("line one\nline two\nline three", 20)).toEqual(["line one\nline two", "line three"]);
    expect(splitText("alpha beta gamma delta", 12)).toEqual(["alpha beta", "gamma delta"]);
  });

  it("hard-cuts text with no whitespace", () => {
    expect(splitText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("never splits an emoji's surrogate pair", () => {
    expect(splitText(`${"a".repeat(9)}😀b`, 10)).toEqual(["a".repeat(9), "😀b"]);
  });

  it("splits a real brief over 4096 chars on paragraph boundaries", () => {
    const paras = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(2, "0")}${"p".repeat(98)}`);
    const text = paras.join("\n\n"); // 5098 chars
    const chunks = splitText(text);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.length <= WA_TEXT_LIMIT)).toBe(true);
    expect(chunks.join("\n\n")).toBe(text);
  });

  it("emoji-dense text near the limit: every chunk fits and is well-formed", () => {
    const text = `a${"😀".repeat(3000)}`; // 6001 UTF-16 units, an emoji straddles index 4096
    const chunks = splitText(text);
    expect(chunks.every((c) => c.length <= WA_TEXT_LIMIT)).toBe(true);
    expect(chunks.some((c) => LONE_SURROGATE.test(c))).toBe(false);
    expect(chunks.join("")).toBe(text);
  });
});
