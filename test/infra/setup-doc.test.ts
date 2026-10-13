import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const doc = readFileSync("docs/setup.md", "utf8");

describe("docs/setup.md", () => {
  it("covers every Meta step the service depends on", () => {
    for (const needle of [
      "whatsapp_business_messaging", "whatsapp_business_management", "System user",
      "Verify token", "/webhooks/whatsapp", "messages", "docs/whatsapp-templates.md",
      "WA_PHONE_NUMBER_ID", "WA_APP_SECRET", "WA_ACCESS_TOKEN", "WA_VERIFY_TOKEN",
    ]) expect(doc, needle).toContain(needle);
  });
  it("has a local-dev runbook", () => {
    for (const needle of [
      "gcloud emulators firestore start --host-port=127.0.0.1:8085", "FIRESTORE_EMULATOR_HOST=127.0.0.1:8085",
      "cloudflared tunnel --url http://localhost:8080", "DEV_SKIP_OIDC=true", "/jobs/tick?now=",
    ]) expect(doc, needle).toContain(needle);
  });
  it("says a newly connected account needs a full deploy (deploy.sh only mounts secrets that had a value)", () => {
    expect(doc).toMatch(/first time after a deploy[^\n]*npm run deploy/);
  });
  it("never shows a secret or phone number being typed on the command line", () => {
    expect(doc).not.toMatch(/versions add \S+ --data-file=- <<<|echo\s+"?sk-ant/);
    expect(doc).not.toMatch(/\b65\d{8}\b/);
  });
});
