import { describe, it, expect } from "vitest";
import { parseSmokeArgs, isLocalUrl, tickUrl, daysBefore } from "../../scripts/lib/smoke.js";

describe("smoke helpers", () => {
  it("parses command, url and now", () => {
    expect(parseSmokeArgs(["health"], {})).toEqual({ command: "health", url: "http://localhost:8080", now: null });
    expect(parseSmokeArgs(["tick", "--now=2026-10-14T06:31:00+08:00", "--url=http://127.0.0.1:9000/"], {}))
      .toEqual({ command: "tick", url: "http://127.0.0.1:9000", now: "2026-10-14T06:31:00+08:00" });
    expect(parseSmokeArgs(["all"], { SMOKE_URL: "https://x.run.app/" }).url).toBe("https://x.run.app");
    expect(() => parseSmokeArgs(["explode"], {})).toThrow(/Usage/);
  });
  it("only allows ?now against a local server", () => {
    expect(isLocalUrl("http://localhost:8080")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLocalUrl("https://kiasu-assistant-1.asia-southeast1.run.app")).toBe(false);
    expect(tickUrl("http://localhost:8080", "2026-10-14T06:31:00+08:00")).toBe(
      "http://localhost:8080/jobs/tick?now=2026-10-13T22%3A31%3A00.000Z");
    expect(tickUrl("http://localhost:8080", null)).toBe("http://localhost:8080/jobs/tick");
    expect(() => tickUrl("https://kiasu-assistant-1.asia-southeast1.run.app", "2026-10-14T06:31:00+08:00")).toThrow(/local/);
  });
  it("daysBefore gives a UTC ISO string", () => {
    expect(daysBefore(new Date("2026-10-14T00:00:00Z"), 2)).toBe("2026-10-12T00:00:00.000Z");
  });
});
