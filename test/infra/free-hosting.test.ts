import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("render.yaml", () => {
  const y = read("render.yaml");
  it("is a free Node web service in Singapore that builds with dev deps and checks /healthz", () => {
    for (const needle of [
      "services:", "- type: web", "name: kiasu-assistant", "runtime: node", "plan: free", "region: singapore",
      "buildCommand: npm ci --include=dev && npm run build", "startCommand: node dist/main.js", "healthCheckPath: /healthz",
    ]) expect(y, needle).toContain(needle);
  });
  it("sets plain values and leaves every secret to the dashboard (sync: false)", () => {
    for (const [k, v] of [
      ["NODE_ENV", "production"], ["MESSENGER", "telegram"], ["TRIAGE_MODEL", "claude-haiku-5-5"],
      ["CHAT_MODEL", "claude-sonnet-5-5"], ["GCP_REGION", "asia-southeast1"],
    ]) expect(y, k).toMatch(new RegExp(`- key: ${k}\\n\\s+value: ${v}\\n`));
    for (const k of [
      "GCP_PROJECT", "PUBLIC_BASE_URL", "ANTHROPIC_API_KEY", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_REFRESH_TOKEN_PERSONAL", "GOOGLE_REFRESH_TOKEN_SCHOOL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID",
      "TELEGRAM_WEBHOOK_SECRET", "JOB_SECRET", "FIRESTORE_CREDENTIALS_JSON", "CLASSROOM_ENABLED",
    ]) expect(y, k).toMatch(new RegExp(`- key: ${k}\\n\\s+sync: false\\n`));
  });
});

describe("docs/setup-free.md", () => {
  const doc = read("docs/setup-free.md");
  it("walks through Telegram, Firebase, Render, the webhook, cron-job.org and a smoke test", () => {
    for (const needle of [
      "BotFather", "/newbot", "npm run telegram:chat-id", "TELEGRAM_CHAT_ID", "openssl rand -hex 32",
      "TELEGRAM_WEBHOOK_SECRET", "JOB_SECRET",
      "console.firebase.google.com", "Spark", "Firestore Database", "asia-southeast1", "Generate new private key",
      "FIRESTORE_CREDENTIALS_JSON",
      "Blueprint", "sontungalt/kiasu", "onrender.com", "PUBLIC_BASE_URL",
      "npm run telegram:webhook --", "cron-job.org", "/jobs/tick", "Authorization: Bearer", "Asia/Singapore",
      "/healthz", "what's due this week?", "750", "15 min",
    ]) expect(doc, needle).toContain(needle);
  });
  it("contains no real secrets, phone numbers or school domains", () => {
    expect(doc).not.toMatch(/\b65\d{8}\b/);
    expect(doc).not.toMatch(/sk-ant-[A-Za-z0-9]/);
    expect(doc).not.toMatch(/\d{8,10}:[A-Za-z0-9_-]{30,}/); // a bot token
    expect(doc).not.toMatch(/BEGIN PRIVATE KEY/);
  });
});

describe(".env.example", () => {
  const env = read(".env.example");
  it("lists the Telegram and free-hosting variables with placeholders only", () => {
    for (const k of ["MESSENGER=", "TELEGRAM_BOT_TOKEN=", "TELEGRAM_CHAT_ID=", "TELEGRAM_WEBHOOK_SECRET=", "JOB_SECRET=", "FIRESTORE_CREDENTIALS_JSON="]) {
      expect(env, k).toContain(k);
    }
    expect(env).not.toMatch(/TELEGRAM_BOT_TOKEN=\d+:/);
  });
});

describe("docs point at the free setup", () => {
  it("AGENTS.md status and spec §3 mention the change", () => {
    expect(read("AGENTS.md")).toContain("docs/setup-free.md");
    const spec = read("docs/superpowers/specs/2026-10-13-kiasu-design.md");
    expect(spec).toContain("Change 2026-10-13: Telegram + no-card hosting");
  });
  it("the Cloud Run runbook is labelled as the option with billing", () => {
    expect(read("docs/setup.md")).toMatch(/with billing/i);
  });
});
