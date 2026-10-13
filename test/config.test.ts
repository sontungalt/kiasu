import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { TEST_ENV } from "./helpers/env.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(TEST_ENV);
    expect(c.PORT).toBe(8080);
    expect(c.TRIAGE_MODEL).toBe("claude-haiku-5-5");
    expect(c.CHAT_MODEL).toBe("claude-sonnet-5-5");
    expect(c.CLASSROOM_ENABLED).toBe(true);
    expect(c.DEV_SKIP_OIDC).toBe(false);
    expect(c.WA_GRAPH_VERSION).toBe("v23.0");
  });

  it("parses booleans", () => {
    const c = loadConfig({ ...TEST_ENV, CLASSROOM_ENABLED: "false" });
    expect(c.CLASSROOM_ENABLED).toBe(false);
  });

  it("rejects a phone number with + or spaces", () => {
    expect(() => loadConfig({ ...TEST_ENV, MY_WHATSAPP_NUMBER: "+65 8000 0000" })).toThrow(/MY_WHATSAPP_NUMBER/);
  });

  it("lists every missing variable", () => {
    expect(() => loadConfig({})).toThrow(/ANTHROPIC_API_KEY[\s\S]*WA_APP_SECRET|WA_APP_SECRET[\s\S]*ANTHROPIC_API_KEY/);
  });

  it("refuses DEV_SKIP_OIDC in production", () => {
    expect(() => loadConfig({ ...TEST_ENV, NODE_ENV: "production", DEV_SKIP_OIDC: "true" })).toThrow(/DEV_SKIP_OIDC/);
  });
});
