/** Builds the plain (non-secret) env vars for Cloud Run from the local .env. */

/** Copied from .env when present. Everything else in .env (secrets, PORT, dev flags, local URLs) is ignored. */
export const COPIED_KEYS = [
  "TRIAGE_MODEL",
  "CHAT_MODEL",
  "WA_PHONE_NUMBER_ID",
  "WA_GRAPH_VERSION",
  "MY_WHATSAPP_NUMBER",
  "CLASSROOM_ENABLED",
] as const;

export interface RunEnvOptions {
  publicBaseUrl: string;
  project: string;
  region: string;
}

export function normaliseBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function buildRunEnv(dotenv: Record<string, string | undefined>, opts: RunEnvOptions): Record<string, string> {
  const { project, region } = opts;
  const out: Record<string, string> = {
    NODE_ENV: "production",
    DEV_SKIP_OIDC: "false",
    PUBLIC_BASE_URL: normaliseBaseUrl(opts.publicBaseUrl),
    GCP_PROJECT: project,
    GCP_REGION: region,
    // Derived from the project so they always match what setup-gcp.sh created.
    GMAIL_PUBSUB_TOPIC: `projects/${project}/topics/gmail-push`,
    INVOKER_SERVICE_ACCOUNT: `invoker@${project}.iam.gserviceaccount.com`,
    TASKS_QUEUE: `projects/${project}/locations/${region}/queues/inbound`,
  };
  for (const key of COPIED_KEYS) {
    const value = dotenv[key]?.trim();
    if (value) out[key] = value;
  }
  if (!out.WA_PHONE_NUMBER_ID) throw new Error("WA_PHONE_NUMBER_ID is missing from .env");
  if (!out.MY_WHATSAPP_NUMBER || !/^\d{8,15}$/.test(out.MY_WHATSAPP_NUMBER)) {
    throw new Error("MY_WHATSAPP_NUMBER in .env must be digits only, with country code");
  }
  return out;
}

/** YAML for `gcloud run deploy --env-vars-file`. JSON strings are valid YAML double-quoted scalars. */
export function toEnvYaml(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n";
}
