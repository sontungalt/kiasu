import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithFakeCli } from "../helpers/fake-cli.js";

const REQUIRED = "ANTHROPIC_API_KEY GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET WA_ACCESS_TOKEN WA_APP_SECRET WA_VERIFY_TOKEN";
const DET_URL = "https://kiasu-assistant-123456789.asia-southeast1.run.app";

function envFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), "deploy-env-")), ".env");
  writeFileSync(file, [
    "GCP_PROJECT=demo-proj",
    "PORT=8080",
    "PUBLIC_BASE_URL=https://example.trycloudflare.com/",
    "ANTHROPIC_API_KEY=sk-should-not-leak",
    "WA_ACCESS_TOKEN=wa-should-not-leak",
    "WA_PHONE_NUMBER_ID=111222333",
    "MY_WHATSAPP_NUMBER=6500000000",
    "DEV_SKIP_OIDC=true",
    "CLASSROOM_ENABLED=false",
  ].join("\n"));
  return file;
}

function deploy(extra: Record<string, string> = {}) {
  return runWithFakeCli("scripts/deploy.sh", ["--skip-watch"], {
    GCP_PROJECT: "demo-proj", GCP_REGION: "asia-southeast1", ENV_FILE: envFile(),
    FAKE_SECRETS: `${REQUIRED} GOOGLE_REFRESH_TOKEN_PERSONAL`, FAKE_URL: DET_URL, ...extra,
  });
}

const line = (log: string[], prefix: string) => log.find((l) => l.startsWith(prefix)) ?? "";

describe("deploy.sh", () => {
  it("deploys with secrets from Secret Manager and plain env from .env (no secrets, no PORT)", () => {
    const r = deploy();
    expect(r.status, r.stderr).toBe(0);
    const d = line(r.log, "gcloud run deploy kiasu-assistant");
    expect(d).toContain("--source . --region=asia-southeast1");
    expect(d).toContain("--service-account=runtime@demo-proj.iam.gserviceaccount.com");
    expect(d).toContain("--allow-unauthenticated");
    expect(d).toContain("--max-instances=1"); // plan 01's sync lock is per process
    expect(d).toContain("ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest");
    expect(d).toContain("GOOGLE_REFRESH_TOKEN_PERSONAL=GOOGLE_REFRESH_TOKEN_PERSONAL:latest");
    expect(d).not.toContain("GOOGLE_REFRESH_TOKEN_SCHOOL");
    const yaml = readFileSync(join(r.dir, "env.yaml"), "utf8");
    expect(yaml).toContain(`PUBLIC_BASE_URL: "${DET_URL}"`);
    expect(yaml).toContain(`NODE_ENV: "production"`);
    expect(yaml).toContain(`DEV_SKIP_OIDC: "false"`);
    expect(yaml).toContain(`CLASSROOM_ENABLED: "false"`);
    expect(yaml).not.toMatch(/should-not-leak|^PORT:/m);
  });

  it("OIDC audiences equal PUBLIC_BASE_URL + path exactly (no double slash)", () => {
    const r = deploy();
    const sub = line(r.log, "gcloud pubsub subscriptions create gmail-push-sub");
    expect(sub).toContain("--topic=gmail-push");
    expect(sub).toContain(`--push-endpoint=${DET_URL}/webhooks/gmail`);
    expect(sub).toContain(`--push-auth-token-audience=${DET_URL}/webhooks/gmail`);
    expect(sub).toContain("--push-auth-service-account=invoker@demo-proj.iam.gserviceaccount.com");
    const job = line(r.log, "gcloud scheduler jobs create http tick");
    expect(job).toContain("--schedule=*/5 * * * *");
    expect(job).toContain("--time-zone=Asia/Singapore");
    expect(job).toContain(`--uri=${DET_URL}/jobs/tick`);
    expect(job).toContain(`--oidc-token-audience=${DET_URL}/jobs/tick`);
    expect(job).toContain("--oidc-service-account-email=invoker@demo-proj.iam.gserviceaccount.com");
    expect(r.log.join("\n")).not.toContain("run.app//");
  });

  it("when the real URL differs from the predicted one, fixes PUBLIC_BASE_URL and wires that URL", () => {
    const r = deploy({ FAKE_URL: "https://kiasu-assistant-abc123xyz-as.a.run.app/" });
    expect(r.status, r.stderr).toBe(0);
    expect(line(r.log, "gcloud run services update kiasu-assistant")).toContain(
      "--update-env-vars=PUBLIC_BASE_URL=https://kiasu-assistant-abc123xyz-as.a.run.app");
    expect(line(r.log, "gcloud pubsub subscriptions create")).toContain(
      "--push-auth-token-audience=https://kiasu-assistant-abc123xyz-as.a.run.app/webhooks/gmail");
  });

  it("updates (not recreates) the subscription and job when they exist", () => {
    const r = deploy({ FAKE_EXISTS: "true" });
    expect(line(r.log, "gcloud pubsub subscriptions update gmail-push-sub")).not.toBe("");
    expect(line(r.log, "gcloud scheduler jobs update http tick")).not.toBe("");
    expect(r.log.some((l) => l.includes("subscriptions create") || l.includes("jobs create"))).toBe(false);
  });

  it("refuses to deploy when a required secret has no value", () => {
    const r = deploy({ FAKE_SECRETS: "ANTHROPIC_API_KEY" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("WA_APP_SECRET");
    expect(r.log.some((l) => l.startsWith("gcloud run deploy"))).toBe(false);
  });

  it("runs gmail:watch unless --skip-watch", () => {
    const r = runWithFakeCli("scripts/deploy.sh", [], {
      GCP_PROJECT: "demo-proj", ENV_FILE: envFile(), FAKE_SECRETS: REQUIRED, FAKE_URL: DET_URL,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain("npm run --silent gmail:watch");
  });
});
