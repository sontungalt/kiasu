import { describe, it, expect } from "vitest";
import {
  writeSecret, readSecret, fillFromSecretManager, projectFromEnv, ALL_SECRET_KEYS, type Runner,
} from "../../scripts/lib/secrets.js";

function fakeRunner(responses: Record<string, { code: number; stdout?: string; stderr?: string }>) {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const run: Runner = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    const key = Object.keys(responses).find((k) => args.join(" ").includes(k));
    const r = key ? responses[key]! : { code: 1 };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

describe("secrets helpers", () => {
  it("lists the 8 secrets from spec §12", () => {
    expect([...ALL_SECRET_KEYS].sort()).toEqual([
      "ANTHROPIC_API_KEY", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_REFRESH_TOKEN_PERSONAL", "GOOGLE_REFRESH_TOKEN_SCHOOL",
      "WA_ACCESS_TOKEN", "WA_APP_SECRET", "WA_VERIFY_TOKEN",
    ]);
  });

  it("writeSecret sends the value on stdin only", async () => {
    const { run, calls } = fakeRunner({ "versions add": { code: 0 } });
    await writeSecret("GOOGLE_REFRESH_TOKEN_SCHOOL", "1//refresh-xyz", "demo-proj", run);
    expect(calls[0]!.cmd).toBe("gcloud");
    expect(calls[0]!.args).toEqual([
      "secrets", "versions", "add", "GOOGLE_REFRESH_TOKEN_SCHOOL", "--data-file=-", "--project=demo-proj", "--format=none",
    ]);
    expect(calls[0]!.args.join(" ")).not.toContain("refresh-xyz");
    expect(calls[0]!.input).toBe("1//refresh-xyz");
  });

  it("writeSecret errors without leaking the value", async () => {
    const { run } = fakeRunner({ "versions add": { code: 1, stderr: "NOT_FOUND: Secret [X] not found" } });
    const err = await writeSecret("X", "super-secret", "p", run).catch((e: Error) => e);
    expect(String(err)).toMatch(/NOT_FOUND/);
    expect(String(err)).not.toContain("super-secret");
  });

  it("readSecret returns the value, or null when missing or empty", async () => {
    expect(await readSecret("A", "p", fakeRunner({ "--secret=A": { code: 0, stdout: "val\n" } }).run)).toBe("val");
    expect(await readSecret("A", "p", fakeRunner({}).run)).toBeNull();
    expect(await readSecret("A", "p", fakeRunner({ "--secret=A": { code: 0, stdout: "" } }).run)).toBeNull();
  });

  it("fillFromSecretManager fills only empty keys and reports names", async () => {
    const env: Record<string, string | undefined> = { A: "local", B: "" };
    const { run, calls } = fakeRunner({ "--secret=B": { code: 0, stdout: "from-sm" }, "--secret=C": { code: 1 } });
    expect(await fillFromSecretManager(env, ["A", "B", "C"], "p", run)).toEqual(["B"]);
    expect(env).toEqual({ A: "local", B: "from-sm" });
    expect(calls.map((c) => c.args.find((a) => a.startsWith("--secret=")))).toEqual(["--secret=B", "--secret=C"]);
    expect(await fillFromSecretManager(env, ["Z"], null, run)).toEqual([]);
  });

  it("projectFromEnv ignores the .env.example placeholder", () => {
    expect(projectFromEnv({ GCP_PROJECT: "your-gcp-project" })).toBeNull();
    expect(projectFromEnv({})).toBeNull();
    expect(projectFromEnv({ GCP_PROJECT: "kiasu-123" })).toBe("kiasu-123");
  });
});
