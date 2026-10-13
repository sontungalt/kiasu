import { describe, it, expect } from "vitest";
import { watchErrorHint } from "../../scripts/lib/watch.js";

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
