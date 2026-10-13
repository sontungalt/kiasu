import { z } from "zod";

const bool = z.enum(["true", "false"]).default("false").transform((v) => v === "true");

const EnvSchema = z
  .object({
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
    GMAIL_PUBSUB_TOPIC: z.string().min(1),
    INVOKER_SERVICE_ACCOUNT: z.email(),
    TASKS_QUEUE: z.string().min(1),
    WA_PHONE_NUMBER_ID: z.string().min(1),
    WA_ACCESS_TOKEN: z.string().min(1),
    WA_APP_SECRET: z.string().min(1),
    WA_VERIFY_TOKEN: z.string().min(1),
    WA_GRAPH_VERSION: z.string().default("v23.0"),
    MY_WHATSAPP_NUMBER: z.string().regex(/^\d{8,15}$/, "digits only, with country code, e.g. 6512345678"),
    CLASSROOM_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
    DEV_SKIP_OIDC: bool,
  })
  .refine((c) => !(c.NODE_ENV === "production" && c.DEV_SKIP_OIDC), {
    message: "DEV_SKIP_OIDC must not be true in production",
    path: ["DEV_SKIP_OIDC"],
  });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
