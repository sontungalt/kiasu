import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("agent instructions", () => {
  const agents = readFileSync("AGENTS.md", "utf8");
  it("AGENTS.md covers reading order, TDD, contracts, commits and the Anthropic SDK", () => {
    for (const needle of [
      "docs/build-prompt.md",
      "docs/superpowers/specs/2026-10-13-kiasu-design.md",
      "docs/superpowers/plans/",
      "first unchecked step",
      "TDD",
      "Contract change",
      "Commit after each task",
      "@anthropic-ai/sdk",
      "OpenAI",
    ]) {
      expect(agents, needle).toContain(needle);
    }
  });
  it("CLAUDE.md points at AGENTS.md", () => {
    expect(readFileSync("CLAUDE.md", "utf8")).toContain("@AGENTS.md");
  });
  it("no committed instruction file contains a real phone number", () => {
    expect(agents).not.toMatch(/\b65\d{8}\b/);
  });
});
