import { describe, it, expect } from "vitest";
import { classifyGoogleError, adviceFor, formatResult, okResult, type AccessResult } from "../../scripts/lib/access.js";

const gaxios = (status: number, error: unknown) => ({ message: "Request failed", response: { status, data: { error } } });

describe("classifyGoogleError", () => {
  it("invalid_grant", () => {
    const err = { message: "invalid_grant", response: { status: 400, data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } };
    expect(classifyGoogleError("gmail", err).kind).toBe("invalid_grant");
  });
  it("scope not granted", () => {
    const err = gaxios(403, { message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED",
      details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] });
    expect(classifyGoogleError("calendar", err)).toMatchObject({ kind: "scope_missing", status: 403 });
  });
  it("API disabled in our own GCP project", () => {
    const err = gaxios(403, { message: "Gmail API has not been used in project 123 before or it is disabled.",
      status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] });
    expect(classifyGoogleError("gmail", err).kind).toBe("api_not_enabled");
  });
  it("blocked by the school's admin", () => {
    expect(classifyGoogleError("classroom", gaxios(403, {
      message: "@ClassroomApiDisabled The user is not permitted to access the Classroom API.", status: "PERMISSION_DENIED",
    })).kind).toBe("blocked_by_admin");
    expect(classifyGoogleError("gmail", gaxios(400, {
      message: "Mail service not enabled", errors: [{ reason: "failedPrecondition" }], status: "FAILED_PRECONDITION",
    })).kind).toBe("blocked_by_admin");
  });
  it("anything else is other, with the message as reason", () => {
    const r = classifyGoogleError("gmail", new Error("getaddrinfo ENOTFOUND gmail.googleapis.com"));
    expect(r).toMatchObject({ kind: "other", status: null });
    expect(r.reason).toContain("ENOTFOUND");
  });
});

describe("adviceFor / formatResult", () => {
  const ok = (api: AccessResult["api"]) => okResult(api);
  const bad = (api: AccessResult["api"], kind: AccessResult["kind"]): AccessResult => ({ api, kind, status: 403, reason: "x" });

  it("all ok", () => {
    expect(adviceFor("school", [ok("gmail"), ok("calendar"), ok("classroom")])).toEqual([
      "All good: the school account can reach Gmail, Calendar and Classroom.",
    ]);
  });
  it("Gmail blocked: prints both §13 fallbacks", () => {
    const a = adviceFor("school", [bad("gmail", "blocked_by_admin"), ok("calendar"), ok("classroom")]).join("\n");
    expect(a).toContain("(a) Gmail auto-forward");
    expect(a).toContain("(b) A Google Apps Script");
  });
  it("only Classroom blocked: suggests CLASSROOM_ENABLED=false and no mail fallback", () => {
    const a = adviceFor("school", [ok("gmail"), ok("calendar"), bad("classroom", "blocked_by_admin")]).join("\n");
    expect(a).toContain("CLASSROOM_ENABLED=false");
    expect(a).not.toContain("auto-forward");
  });
  it("invalid_grant: re-run auth for that account", () => {
    expect(adviceFor("personal", [bad("gmail", "invalid_grant")]).join("\n")).toContain("npm run auth -- personal");
  });
  it("formats results", () => {
    expect(formatResult(ok("gmail"))).toBe("✅ gmail");
    expect(formatResult(bad("classroom", "blocked_by_admin"))).toBe("❌ classroom: blocked_by_admin (403): x");
  });
});
