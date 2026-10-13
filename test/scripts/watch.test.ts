import { describe, it, expect } from "vitest";
import { watchErrorHint, watchOutcome } from "../../scripts/lib/watch.js";
import type { AccountState } from "../../src/types.js";

const TOPIC = "projects/demo-proj/topics/gmail-push";

describe("watchErrorHint", () => {
  it("watchErrorHint explains a missing publisher grant", () => {
    const h = watchErrorHint(new Error(`Error sending test message to Cloud PubSub ${TOPIC} : User not authorized to perform this action.`), TOPIC);
    expect(h).toContain("gmail-api-push@system.gserviceaccount.com");
    expect(h).toContain("npm run setup:gcp");
  });
  it("explains a missing or misnamed topic", () => {
    expect(watchErrorHint(new Error("Invalid topicName does not match projects/demo-proj/topics/*"), TOPIC)).toContain(TOPIC);
    expect(watchErrorHint(new Error("Resource not found (resource=gmail-push)."), TOPIC)).toContain("npm run setup:gcp");
  });
  it("explains a revoked token", () => {
    expect(watchErrorHint({ response: { data: { error: "invalid_grant" } } }, TOPIC)).toContain("npm run auth");
  });
  it("returns null for anything else", () => {
    expect(watchErrorHint(new Error("socket hang up"), TOPIC)).toBeNull();
  });
});

describe("watchOutcome", () => {
  const now = new Date("2026-10-14T00:00:00Z");
  const base: AccountState = {
    id: "personal", email: "", historyId: "1", watchExpiresAt: "2026-10-21T00:00:00.000Z", lastSyncAt: null, authStatus: "ok",
  };
  it("is ok when the watch expires in the future", () => {
    const r = watchOutcome("personal", base, now);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("2026-10-21T00:00:00.000Z");
  });
  it("fails a revoked account (renewWatchIfNeeded swallows invalid_grant) and says how to reconnect", () => {
    const r = watchOutcome("personal", { ...base, authStatus: "revoked" }, now);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("npm run auth -- personal");
  });
  it("fails when there is no watch, or it has already expired", () => {
    expect(watchOutcome("school", null, now).ok).toBe(false);
    expect(watchOutcome("personal", { ...base, watchExpiresAt: null }, now).ok).toBe(false);
    expect(watchOutcome("personal", { ...base, watchExpiresAt: "2026-10-13T00:00:00.000Z" }, now).ok).toBe(false);
  });
});
