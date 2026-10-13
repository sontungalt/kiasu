import { describe, it, expect } from "vitest";
import { buildRunEnv, normaliseBaseUrl, toEnvYaml } from "../../scripts/lib/deploy-env.js";

const opts = { publicBaseUrl: "https://kiasu-assistant-1.asia-southeast1.run.app/", project: "demo-proj", region: "asia-southeast1" };
const dotenv = {
  ANTHROPIC_API_KEY: "sk-leak", WA_ACCESS_TOKEN: "wa-leak", PORT: "8080", DEV_SKIP_OIDC: "true", NODE_ENV: "development",
  PUBLIC_BASE_URL: "https://tunnel.trycloudflare.com", GMAIL_PUBSUB_TOPIC: "projects/your-gcp-project/topics/gmail-push",
  WA_PHONE_NUMBER_ID: "111", MY_WHATSAPP_NUMBER: "6500000000", CLASSROOM_ENABLED: "false", TRIAGE_MODEL: "claude-haiku-5-5",
};

describe("buildRunEnv", () => {
  it("keeps only plain config, forces production values, derives resource names from the project", () => {
    expect(buildRunEnv(dotenv, opts)).toEqual({
      NODE_ENV: "production",
      DEV_SKIP_OIDC: "false",
      PUBLIC_BASE_URL: "https://kiasu-assistant-1.asia-southeast1.run.app",
      GCP_PROJECT: "demo-proj",
      GCP_REGION: "asia-southeast1",
      GMAIL_PUBSUB_TOPIC: "projects/demo-proj/topics/gmail-push",
      INVOKER_SERVICE_ACCOUNT: "invoker@demo-proj.iam.gserviceaccount.com",
      TASKS_QUEUE: "projects/demo-proj/locations/asia-southeast1/queues/inbound",
      TRIAGE_MODEL: "claude-haiku-5-5",
      WA_PHONE_NUMBER_ID: "111",
      MY_WHATSAPP_NUMBER: "6500000000",
      CLASSROOM_ENABLED: "false",
    });
  });
  it("requires WA_PHONE_NUMBER_ID and a digits-only MY_WHATSAPP_NUMBER", () => {
    expect(() => buildRunEnv({ ...dotenv, WA_PHONE_NUMBER_ID: "" }, opts)).toThrow(/WA_PHONE_NUMBER_ID/);
    expect(() => buildRunEnv({ ...dotenv, MY_WHATSAPP_NUMBER: "+65 8000 0000" }, opts)).toThrow(/MY_WHATSAPP_NUMBER/);
  });
  it("normalises trailing slashes and writes YAML-safe quoted values", () => {
    expect(normaliseBaseUrl(" https://x.run.app/// ")).toBe("https://x.run.app");
    expect(toEnvYaml({ A: "1", B: 'say "hi": yes' })).toBe('A: "1"\nB: "say \\"hi\\": yes"\n');
  });
});
