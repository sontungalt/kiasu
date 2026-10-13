import { z } from "zod";

const bool = z.enum(["true", "false"]).default("false").transform((v) => v === "true");

/** Telegram's allowed charset and length for setWebhook's secret_token. */
const TELEGRAM_SECRET_RE = /^[A-Za-z0-9_-]{16,256}$/;

const ObjectSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  GCP_PROJECT: z.string().min(1),
  GCP_REGION: z.string().default("asia-southeast1"),
  PUBLIC_BASE_URL: z.url(),
  ANTHROPIC_API_KEY: z.string().min(1),
  TRIAGE_MODEL: z.string().default("claude-haiku-5-5"),
  CHAT_MODEL: z.string().default("claude-sonnet-5-5"),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN_PERSONAL: z.string().optional(),
  GOOGLE_REFRESH_TOKEN_SCHOOL: z.string().optional(),
  /** Unset: no Gmail push (users.watch); the 5-minute tick polls instead. */
  GMAIL_PUBSUB_TOPIC: z.string().min(1).optional(),
  /** Set: Google OIDC tokens from this service account are accepted on /jobs, /tasks and /webhooks/gmail. */
  INVOKER_SERVICE_ACCOUNT: z.email().optional(),
  /** Set: inbound messages go through Cloud Tasks. Unset: the in-process queue. */
  TASKS_QUEUE: z.string().min(1).optional(),
  /** Shared secret for callers that can't mint Google OIDC tokens (cron-job.org): `Authorization: Bearer <JOB_SECRET>`. */
  JOB_SECRET: z.string().min(32, "must be at least 32 characters (openssl rand -hex 32)").optional(),
  /** A service-account key (JSON) for Firestore outside Google Cloud. Unset: Application Default Credentials. */
  FIRESTORE_CREDENTIALS_JSON: z.string().min(1).optional(),
  MESSENGER: z.enum(["telegram", "whatsapp"]).default("telegram"),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  /** Unset during setup: every inbound message is ignored and its chat id logged. */
  TELEGRAM_CHAT_ID: z.string().regex(/^-?\d+$/, "an integer chat id, e.g. 123456789").optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(TELEGRAM_SECRET_RE, "16-256 characters of A-Z, a-z, 0-9, _ and -").optional(),
  WA_PHONE_NUMBER_ID: z.string().min(1).optional(),
  WA_ACCESS_TOKEN: z.string().min(1).optional(),
  WA_APP_SECRET: z.string().min(1).optional(),
  WA_VERIFY_TOKEN: z.string().min(1).optional(),
  WA_GRAPH_VERSION: z.string().default("v23.0"),
  MY_WHATSAPP_NUMBER: z.string().regex(/^\d{8,15}$/, "digits only, with country code, e.g. 6512345678").optional(),
  CLASSROOM_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  DEV_SKIP_OIDC: bool,
});

type Parsed = z.output<typeof ObjectSchema>;

const REQUIRED_BY_MESSENGER = {
  whatsapp: ["WA_PHONE_NUMBER_ID", "WA_ACCESS_TOKEN", "WA_APP_SECRET", "WA_VERIFY_TOKEN", "MY_WHATSAPP_NUMBER"],
  telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"],
} as const satisfies Record<Parsed["MESSENGER"], ReadonlyArray<keyof Parsed>>;

const EnvSchema = z.preprocess(
  // An empty line in .env ("KEY=") means unset, so optional values can be left blank.
  (env) =>
    typeof env === "object" && env !== null
      ? Object.fromEntries(Object.entries(env).filter(([, v]) => !(typeof v === "string" && v.trim() === "")))
      : env,
  ObjectSchema.superRefine(
    (c, ctx) => {
      const issue = (path: keyof Parsed, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
      if (c.NODE_ENV === "production" && c.DEV_SKIP_OIDC) issue("DEV_SKIP_OIDC", "DEV_SKIP_OIDC must not be true in production");
      const messenger = (REQUIRED_BY_MESSENGER as Record<string, readonly (keyof Parsed)[]>)[c.MESSENGER] ?? [];
      for (const key of messenger) {
        if (c[key] === undefined) issue(key, `required when MESSENGER=${c.MESSENGER}`);
      }
      if (c.NODE_ENV === "production" && !c.INVOKER_SERVICE_ACCOUNT && !c.JOB_SECRET) {
        issue("JOB_SECRET", "production needs INVOKER_SERVICE_ACCOUNT or JOB_SECRET to authenticate /jobs/tick");
      }
      if (!c.DEV_SKIP_OIDC && c.TASKS_QUEUE && !c.INVOKER_SERVICE_ACCOUNT) {
        issue("INVOKER_SERVICE_ACCOUNT", "required with TASKS_QUEUE (Cloud Tasks signs its calls as this account)");
      }
      if (!c.DEV_SKIP_OIDC && !c.TASKS_QUEUE && !c.JOB_SECRET) {
        issue("JOB_SECRET", "required without TASKS_QUEUE: the in-process queue calls /tasks/handle-message with it");
      }
    },
    // Run even when a field failed, so one error message lists everything that's missing.
    { when: (p) => typeof p.value === "object" && p.value !== null },
  ),
);

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
