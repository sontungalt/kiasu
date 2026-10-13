import { describe, it, expect } from "vitest";
import { googleAuthFor, isInvalidGrant, GOOGLE_SCOPES } from "../../src/google/auth.js";
import { loadConfig } from "../../src/config.js";
import { TEST_ENV } from "../helpers/env.js";

describe("google auth", () => {
  it("builds a client per account, null when token missing", () => {
    const config = loadConfig({ ...TEST_ENV, GOOGLE_REFRESH_TOKEN_SCHOOL: "" });
    expect(googleAuthFor("personal", config)).not.toBeNull();
    expect(googleAuthFor("school", config)).toBeNull();
  });

  it("requests gmail, calendar and classroom read scopes", () => {
    expect(GOOGLE_SCOPES).toEqual(expect.arrayContaining([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/classroom.courses.readonly",
      "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
      "https://www.googleapis.com/auth/classroom.announcements.readonly",
    ]));
    expect(GOOGLE_SCOPES.some((s) => /gmail\.(modify|send|compose)|mail\.google\.com/.test(s))).toBe(false);
  });

  it("detects invalid_grant in its common shapes", () => {
    expect(isInvalidGrant({ response: { data: { error: "invalid_grant" } } })).toBe(true);
    expect(isInvalidGrant(new Error("invalid_grant: Token has been expired or revoked."))).toBe(true);
    expect(isInvalidGrant(new Error("quota exceeded"))).toBe(false);
  });
});
