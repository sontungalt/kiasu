import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runWithFakeCli } from "../helpers/fake-cli.js";
import { ALL_SECRET_KEYS } from "../../scripts/lib/secrets.js";

const ENV = { GCP_PROJECT: "demo-proj", GCP_REGION: "asia-southeast1" };
const has = (log: string[], prefix: string) => log.some((l) => l.startsWith(prefix));

describe("setup-gcp.sh", () => {
  it("creates everything on a fresh project", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", [], ENV);
    expect(r.status, r.stderr).toBe(0);
    expect(r.log.find((l) => l.startsWith("gcloud services enable"))).toMatch(
      /run\.googleapis\.com.*firestore.*pubsub.*cloudtasks.*cloudscheduler.*secretmanager.*gmail.*calendar-json.*classroom.*cloudbuild.*artifactregistry/);
    expect(has(r.log, "gcloud firestore databases create --database=(default) --location=asia-southeast1 --type=firestore-native")).toBe(true);
    expect(has(r.log, "gcloud iam service-accounts create invoker")).toBe(true);
    expect(has(r.log, "gcloud iam service-accounts create runtime")).toBe(true);
    expect(has(r.log, "gcloud pubsub topics create gmail-push")).toBe(true);
    expect(has(r.log, "gcloud tasks queues create inbound --location=asia-southeast1 --max-attempts=5")).toBe(true);
    for (const s of ALL_SECRET_KEYS) {
      expect(has(r.log, `gcloud secrets create ${s} --replication-policy=automatic`), s).toBe(true);
    }
  });

  it("grants Gmail's push service account publish rights on the topic", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", [], ENV);
    expect(has(r.log, "gcloud pubsub topics add-iam-policy-binding gmail-push --member=serviceAccount:gmail-api-push@system.gserviceaccount.com --role=roles/pubsub.publisher")).toBe(true);
  });

  it("lets runtime@ act as invoker@ (needed to create OIDC Cloud Tasks) and grants runtime roles", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", [], ENV);
    expect(has(r.log, "gcloud iam service-accounts add-iam-policy-binding invoker@demo-proj.iam.gserviceaccount.com --member=serviceAccount:runtime@demo-proj.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser")).toBe(true);
    for (const role of ["roles/datastore.user", "roles/cloudtasks.enqueuer", "roles/secretmanager.secretAccessor"]) {
      expect(has(r.log, `gcloud projects add-iam-policy-binding demo-proj --member=serviceAccount:runtime@demo-proj.iam.gserviceaccount.com --role=${role}`), role).toBe(true);
    }
    expect(has(r.log, "gcloud iam service-accounts add-iam-policy-binding invoker@demo-proj.iam.gserviceaccount.com --member=serviceAccount:service-123456789@gcp-sa-pubsub.iam.gserviceaccount.com --role=roles/iam.serviceAccountTokenCreator")).toBe(true);
    expect(has(r.log, "gcloud projects add-iam-policy-binding demo-proj --member=serviceAccount:123456789-compute@developer.gserviceaccount.com --role=roles/run.builder")).toBe(true);
  });

  it("never puts the access token on a command line", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", [], ENV);
    const curlArgs = r.log.filter((l) => l.startsWith("curl "));
    expect(curlArgs).toHaveLength(2);
    expect(curlArgs.join("\n")).not.toContain("fake-access-token");
    expect(r.log.filter((l) => l.startsWith("curl-stdin:")).join("\n")).toContain("Authorization: Bearer fake-access-token");
  });

  it("is idempotent: re-running against existing resources creates nothing and updates the queue", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", [], { ...ENV, FAKE_EXISTS: "true" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.log.filter((l) => / create /.test(l))).toEqual([]);
    expect(has(r.log, "gcloud tasks queues update inbound")).toBe(true);
  });

  it("--dry-run only reads; mutating commands are printed instead", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", ["--dry-run"], ENV);
    expect(r.status, r.stderr).toBe(0);
    expect(r.log.every((l) => / describe /.test(l) || l.startsWith("gcloud projects describe"))).toBe(true);
    expect(r.stdout).toContain("[dry-run] gcloud pubsub topics create gmail-push");
  });

  it("fails clearly without GCP_PROJECT", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", [], { GCP_PROJECT: "" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Set GCP_PROJECT");
  });
});

describe("set-secret.sh", () => {
  it("set-secret.sh passes the value on stdin, never as an argument", () => {
    const r = runWithFakeCli("scripts/set-secret.sh", ["ANTHROPIC_API_KEY"], ENV, "sk-ant-secret-123\n");
    expect(r.status, r.stderr).toBe(0);
    expect(r.log.find((l) => l.startsWith("gcloud secrets versions add"))).toBe(
      "gcloud secrets versions add ANTHROPIC_API_KEY --data-file=- --format=none");
    expect(r.log).toContain("stdin: sk-ant-secret-123");
  });

  it("rejects unknown names and empty values", () => {
    expect(runWithFakeCli("scripts/set-secret.sh", ["NOPE"], ENV, "x\n").status).not.toBe(0);
    expect(runWithFakeCli("scripts/set-secret.sh", ["WA_APP_SECRET"], ENV, "\n").status).not.toBe(0);
  });
});

describe("secret names", () => {
  it("common.sh lists exactly ALL_SECRET_KEYS", () => {
    const sh = readFileSync("scripts/lib/common.sh", "utf8");
    const names = [...sh.matchAll(/^(?:REQUIRED|OPTIONAL)_SECRETS=\(([^)]*)\)/gm)].flatMap((m) => m[1]!.trim().split(/\s+/));
    expect(names.sort()).toEqual([...ALL_SECRET_KEYS].sort());
  });
});
