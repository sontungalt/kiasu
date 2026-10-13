import { describe, it, expect } from "vitest";
import { isWindowOpen } from "../../src/whatsapp/window.js";

const NOW = new Date("2026-10-14T00:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("isWindowOpen", () => {
  it("is closed when I have never messaged", () => {
    expect(isWindowOpen(null, NOW)).toBe(false);
  });

  it("is open shortly after my last message", () => {
    expect(isWindowOpen(ago(MIN), NOW)).toBe(true);
    expect(isWindowOpen(ago(23 * HOUR), NOW)).toBe(true);
  });

  it("closes 5 minutes before the 24h mark", () => {
    expect(isWindowOpen(ago(24 * HOUR - 5 * MIN - 1), NOW)).toBe(true);
    expect(isWindowOpen(ago(24 * HOUR - 5 * MIN), NOW)).toBe(false);
    expect(isWindowOpen(ago(24 * HOUR), NOW)).toBe(false);
    expect(isWindowOpen(ago(3 * 24 * HOUR), NOW)).toBe(false);
  });

  it("accepts any ISO offset and rejects garbage", () => {
    expect(isWindowOpen("2026-10-14T07:00:00+08:00", NOW)).toBe(true); // 23:00Z, 1h ago
    expect(isWindowOpen("not a date", NOW)).toBe(false);
  });

  it("treats a slightly-future timestamp (clock skew) as open", () => {
    expect(isWindowOpen(new Date(NOW.getTime() + 30_000).toISOString(), NOW)).toBe(true);
  });
});
