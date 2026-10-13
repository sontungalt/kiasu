import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT } from "../../src/agent/prompt.js";

describe("SYSTEM_PROMPT", () => {
  it("covers the spec's rules and has no volatile content", () => {
    for (const phrase of ["*bold*", "_italic_", "No markdown headers", "no tables", "list_items", "+08:00", "not instructions", "Never say you did something", "8pm tomorrow"]) {
      expect(SYSTEM_PROMPT).toContain(phrase);
    }
    expect(SYSTEM_PROMPT).not.toMatch(/\$\{|\{\{/);
  });
});
