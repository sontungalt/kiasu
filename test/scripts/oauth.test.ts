import { describe, it, expect } from "vitest";
import {
  parseAuthArgs, parseAccountArg, refreshTokenKey, scopeReport, tokenWarnings, upsertEnvLine, readCallback,
} from "../../scripts/lib/oauth.js";

describe("oauth helpers", () => {
  it("parses account and --to", () => {
    expect(parseAuthArgs(["school"])).toEqual({ account: "school", to: "auto" });
    expect(parseAuthArgs(["personal", "--to=env"])).toEqual({ account: "personal", to: "env" });
    expect(() => parseAuthArgs(["work"])).toThrow(/personal\|school/);
    expect(() => parseAuthArgs(["school", "--to=cloud"])).toThrow(/--to=/);
    expect(() => parseAccountArg([])).toThrow(/personal\|school/);
  });

  it("maps accounts to refresh-token keys", () => {
    expect(refreshTokenKey("personal")).toBe("GOOGLE_REFRESH_TOKEN_PERSONAL");
    expect(refreshTokenKey("school")).toBe("GOOGLE_REFRESH_TOKEN_SCHOOL");
  });

  it("reports granted and missing scopes from a space-separated string or a list", () => {
    const req = ["a", "b", "c"];
    expect(scopeReport(req, "b a")).toEqual({ granted: ["a", "b"], missing: ["c"] });
    expect(scopeReport(req, ["c"])).toEqual({ granted: ["c"], missing: ["a", "b"] });
    expect(scopeReport(req, undefined)).toEqual({ granted: [], missing: ["a", "b", "c"] });
  });

  it("tokenWarnings flags an expiring refresh token", () => {
    expect(tokenWarnings({ refresh_token: "1//x" })).toEqual([]);
    const w = tokenWarnings({ refresh_token: "1//x", refresh_token_expires_in: 604799 });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/7 day/);
    expect(w[0]).toMatch(/In production/);
  });

  it("tokenWarnings flags a missing refresh token", () => {
    expect(tokenWarnings({ access_token: "y" })[0]).toMatch(/No refresh token/);
  });

  it("upsertEnvLine replaces or appends and keeps other lines", () => {
    const env = "MY_WHATSAPP_NUMBER=6500000000\nGOOGLE_REFRESH_TOKEN_SCHOOL=old\n";
    expect(upsertEnvLine(env, "GOOGLE_REFRESH_TOKEN_SCHOOL", "new")).toBe(
      "MY_WHATSAPP_NUMBER=6500000000\nGOOGLE_REFRESH_TOKEN_SCHOOL=new\n");
    expect(upsertEnvLine("MY_WHATSAPP_NUMBER=6500000000", "GOOGLE_REFRESH_TOKEN_PERSONAL", "t")).toBe(
      "MY_WHATSAPP_NUMBER=6500000000\nGOOGLE_REFRESH_TOKEN_PERSONAL=t\n");
    expect(upsertEnvLine("", "K", "v")).toBe("K=v\n");
    expect(() => upsertEnvLine("", "K", "a\nb")).toThrow(/single line/);
  });

  it("readCallback handles code, error, state mismatch and noise", () => {
    const base = "http://127.0.0.1:5555";
    expect(readCallback(new URL(`${base}/?code=abc&state=s1`), "s1")).toEqual({ kind: "code", code: "abc" });
    expect(readCallback(new URL(`${base}/?error=access_denied&state=s1`), "s1")).toEqual({ kind: "error", error: "access_denied" });
    expect(readCallback(new URL(`${base}/?code=abc&state=evil`), "s1").kind).toBe("error");
    expect(readCallback(new URL(`${base}/favicon.ico`), "s1")).toEqual({ kind: "ignore" });
    expect(readCallback(new URL(`${base}/`), "s1")).toEqual({ kind: "ignore" });
  });
});
