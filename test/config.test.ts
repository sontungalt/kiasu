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
    expect(() => loadConfig({ MESSENGER: "whatsapp" })).toThrow(/ANTHROPIC_API_KEY[\s\S]*WA_APP_SECRET|WA_APP_SECRET[\s\S]*ANTHROPIC_API_KEY/);
    expect(() => loadConfig({})).toThrow(/ANTHROPIC_API_KEY[\s\S]*TELEGRAM_BOT_TOKEN|TELEGRAM_BOT_TOKEN[\s\S]*ANTHROPIC_API_KEY/);
  });

  it("refuses DEV_SKIP_OIDC in production", () => {
    expect(() => loadConfig({ ...TEST_ENV, NODE_ENV: "production", DEV_SKIP_OIDC: "true" })).toThrow(/DEV_SKIP_OIDC/);
  });
});

/** The free-hosting setup: Telegram, no Pub/Sub, no Cloud Tasks, no WhatsApp. */
const TELEGRAM_ENV: Record<string, string> = {
  GCP_PROJECT: "demo-inbox",
  PUBLIC_BASE_URL: "https://kiasu.example.com",
  ANTHROPIC_API_KEY: "sk-ant-test",
  GOOGLE_OAUTH_CLIENT_ID: "cid",
  GOOGLE_OAUTH_CLIENT_SECRET: "csecret",
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_WEBHOOK_SECRET: "tg_secret-0123456789",
  JOB_SECRET: "j".repeat(32),
};

describe("loadConfig: messenger and free hosting", () => {
  it("defaults to Telegram and needs no WhatsApp, Pub/Sub, invoker or Cloud Tasks values", () => {
    const c = loadConfig(TELEGRAM_ENV);
    expect(c.MESSENGER).toBe("telegram");
    expect(c.WA_PHONE_NUMBER_ID).toBeUndefined();
    expect(c.MY_WHATSAPP_NUMBER).toBeUndefined();
    expect(c.GMAIL_PUBSUB_TOPIC).toBeUndefined();
    expect(c.INVOKER_SERVICE_ACCOUNT).toBeUndefined();
    expect(c.TASKS_QUEUE).toBeUndefined();
    expect(c.TELEGRAM_CHAT_ID).toBeUndefined();
  });

  it("MESSENGER=telegram requires the bot token and webhook secret", () => {
    const { TELEGRAM_BOT_TOKEN: _t, TELEGRAM_WEBHOOK_SECRET: _s, ...rest } = TELEGRAM_ENV;
    expect(() => loadConfig(rest)).toThrow(/TELEGRAM_BOT_TOKEN[\s\S]*TELEGRAM_WEBHOOK_SECRET/);
  });

  it("MESSENGER=whatsapp requires every WhatsApp value", () => {
    expect(() => loadConfig({ ...TELEGRAM_ENV, MESSENGER: "whatsapp" }))
      .toThrow(/WA_PHONE_NUMBER_ID[\s\S]*WA_ACCESS_TOKEN[\s\S]*WA_APP_SECRET[\s\S]*WA_VERIFY_TOKEN[\s\S]*MY_WHATSAPP_NUMBER/);
    expect(() => loadConfig({ ...TELEGRAM_ENV, MESSENGER: "signal" })).toThrow(/MESSENGER/);
  });

  it("TELEGRAM_CHAT_ID is an optional integer string that may be negative; empty means unset", () => {
    expect(loadConfig({ ...TELEGRAM_ENV, TELEGRAM_CHAT_ID: "123456789" }).TELEGRAM_CHAT_ID).toBe("123456789");
    expect(loadConfig({ ...TELEGRAM_ENV, TELEGRAM_CHAT_ID: "-1001234567890" }).TELEGRAM_CHAT_ID).toBe("-1001234567890");
    expect(loadConfig({ ...TELEGRAM_ENV, TELEGRAM_CHAT_ID: "" }).TELEGRAM_CHAT_ID).toBeUndefined();
    expect(() => loadConfig({ ...TELEGRAM_ENV, TELEGRAM_CHAT_ID: "@me" })).toThrow(/TELEGRAM_CHAT_ID/);
    expect(() => loadConfig({ ...TELEGRAM_ENV, TELEGRAM_CHAT_ID: "12.5" })).toThrow(/TELEGRAM_CHAT_ID/);
  });

  it("TELEGRAM_WEBHOOK_SECRET uses Telegram's charset and length (16-256 of A-Z a-z 0-9 _ -)", () => {
    expect(() => loadConfig({ ...TELEGRAM_ENV, TELEGRAM_WEBHOOK_SECRET: "short" })).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...TELEGRAM_ENV, TELEGRAM_WEBHOOK_SECRET: "has spaces in it ok" })).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...TELEGRAM_ENV, TELEGRAM_WEBHOOK_SECRET: "a".repeat(257) })).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(loadConfig({ ...TELEGRAM_ENV, TELEGRAM_WEBHOOK_SECRET: "f".repeat(64) }).TELEGRAM_WEBHOOK_SECRET).toBe("f".repeat(64));
  });

  it("JOB_SECRET must be at least 32 characters", () => {
    expect(() => loadConfig({ ...TELEGRAM_ENV, JOB_SECRET: "too-short" })).toThrow(/JOB_SECRET/);
  });

  it("production needs INVOKER_SERVICE_ACCOUNT or JOB_SECRET", () => {
    const { JOB_SECRET: _j, ...noSecret } = TELEGRAM_ENV;
    expect(() => loadConfig({ ...noSecret, NODE_ENV: "production" })).toThrow(/INVOKER_SERVICE_ACCOUNT or JOB_SECRET/);
    expect(loadConfig({ ...TELEGRAM_ENV, NODE_ENV: "production" }).JOB_SECRET).toBe("j".repeat(32));
  });

  it("the in-process queue (no TASKS_QUEUE) needs JOB_SECRET to call /tasks/handle-message, unless DEV_SKIP_OIDC", () => {
    const { JOB_SECRET: _j, ...noSecret } = TELEGRAM_ENV;
    expect(() => loadConfig(noSecret)).toThrow(/JOB_SECRET/);
    expect(loadConfig({ ...noSecret, DEV_SKIP_OIDC: "true" }).DEV_SKIP_OIDC).toBe(true);
  });

  it("Cloud Tasks (TASKS_QUEUE) needs INVOKER_SERVICE_ACCOUNT for its OIDC token", () => {
    expect(() => loadConfig({ ...TELEGRAM_ENV, TASKS_QUEUE: "projects/p/locations/l/queues/q" })).toThrow(/INVOKER_SERVICE_ACCOUNT/);
  });

  it("keeps FIRESTORE_CREDENTIALS_JSON as a string", () => {
    const json = JSON.stringify({ client_email: "sa@demo-inbox.iam.gserviceaccount.com", private_key: "k" });
    expect(loadConfig({ ...TELEGRAM_ENV, FIRESTORE_CREDENTIALS_JSON: json }).FIRESTORE_CREDENTIALS_JSON).toBe(json);
  });
});
