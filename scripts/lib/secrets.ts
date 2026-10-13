import { spawn } from "node:child_process";

/** Every Secret Manager secret the service uses (spec §12). Mirrored in scripts/lib/common.sh (a test checks it). */
export const ALL_SECRET_KEYS = [
  "ANTHROPIC_API_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "WA_ACCESS_TOKEN",
  "WA_APP_SECRET",
  "WA_VERIFY_TOKEN",
  "GOOGLE_REFRESH_TOKEN_PERSONAL",
  "GOOGLE_REFRESH_TOKEN_SCHOOL",
] as const;
export type SecretKey = (typeof ALL_SECRET_KEYS)[number];

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs a command without a shell. `input` goes to stdin, so it never appears in argv or the process list. */
export type Runner = (cmd: string, args: string[], input?: string) => Promise<RunResult>;

export const defaultRunner: Runner = (cmd, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });

/** GCP_PROJECT, unless it's unset or still the .env.example placeholder. */
export function projectFromEnv(env: Record<string, string | undefined>): string | null {
  const p = env.GCP_PROJECT?.trim();
  return p && p !== "your-gcp-project" ? p : null;
}

export async function secretExists(name: string, project: string, run: Runner = defaultRunner): Promise<boolean> {
  const r = await run("gcloud", ["secrets", "describe", name, `--project=${project}`, "--format=value(name)"]);
  return r.code === 0;
}

export async function writeSecret(name: string, value: string, project: string, run: Runner = defaultRunner): Promise<void> {
  const r = await run(
    "gcloud",
    ["secrets", "versions", "add", name, "--data-file=-", `--project=${project}`, "--format=none"],
    value,
  );
  if (r.code !== 0) throw new Error(`gcloud secrets versions add ${name} failed: ${r.stderr.trim()}`);
}

/** The latest enabled version, or null if the secret is missing or has no versions. */
export async function readSecret(name: string, project: string, run: Runner = defaultRunner): Promise<string | null> {
  const r = await run("gcloud", ["secrets", "versions", "access", "latest", `--secret=${name}`, `--project=${project}`]);
  if (r.code !== 0) return null;
  const value = r.stdout.trimEnd();
  return value === "" ? null : value;
}

/**
 * For each key that's empty in `env`, copies the latest Secret Manager value into it.
 * Returns the names (never the values) that were filled. Does nothing without a project.
 */
export async function fillFromSecretManager(
  env: Record<string, string | undefined>,
  keys: readonly string[],
  project: string | null,
  run: Runner = defaultRunner,
): Promise<string[]> {
  if (!project) return [];
  const filled: string[] = [];
  for (const key of keys) {
    if (env[key]) continue;
    const value = await readSecret(key, project, run);
    if (value !== null) {
      env[key] = value;
      filled.push(key);
    }
  }
  return filled;
}
