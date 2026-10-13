import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("container", () => {
  it("Dockerfile: multi-stage node:24-slim, npm ci, build, prune, non-root, starts dist/main.js", () => {
    const d = read("Dockerfile");
    expect(d).toMatch(/^FROM node:24-slim AS build$/m);
    expect(d).toMatch(/^FROM node:24-slim$/m);
    expect(d).toContain("RUN npm ci");
    expect(d).toContain("npm run build");
    expect(d).toContain("npm prune --omit=dev");
    expect(d).toMatch(/^USER node$/m);
    expect(d).toContain('CMD ["node", "dist/main.js"]');
    expect(d).not.toMatch(/COPY \. /);
  });

  it(".dockerignore keeps secrets, fixtures and bulk out of the build context", () => {
    const lines = read(".dockerignore").split("\n").map((l) => l.trim());
    for (const p of [".env", ".env.*", "node_modules", "docs", "evals/triage/fixtures", "evals/triage/labels.json", ".git"]) {
      expect(lines, p).toContain(p);
    }
    expect(lines).toContain("!.env.example");
  });

  it(".gcloudignore includes .gitignore (which ignores .env) so --source never uploads secrets", () => {
    expect(read(".gcloudignore").split("\n")[0]).toBe("#!include:.gitignore");
    expect(read(".gitignore").split("\n")).toContain(".env");
  });
});
