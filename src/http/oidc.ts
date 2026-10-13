import { timingSafeEqual } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import type { preHandlerHookHandler } from "fastify";
import type { Deps } from "../ports.js";

export type IdTokenVerifier = (
  idToken: string,
  audience: string,
) => Promise<{ email?: string; email_verified?: boolean } | undefined>;

const client = new OAuth2Client();
const googleVerifier: IdTokenVerifier = async (idToken, audience) =>
  (await client.verifyIdToken({ idToken, audience })).getPayload();

export async function verifyGoogleOidc(
  authHeader: string | undefined,
  opts: { audience: string; email: string },
  verify: IdTokenVerifier = googleVerifier,
): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) return false;
  try {
    const payload = await verify(authHeader.slice("Bearer ".length), opts.audience);
    return !!payload && payload.email === opts.email && payload.email_verified === true;
  } catch {
    return false;
  }
}

/** True when the header is exactly `Bearer <secret>`. Constant-time once the lengths match. */
export function matchesBearerSecret(authHeader: string | undefined, secret: string | undefined): boolean {
  if (!secret || !authHeader?.startsWith("Bearer ")) return false;
  const given = Buffer.from(authHeader.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(secret, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Authenticates machine callers (/jobs/tick, /tasks/*, /webhooks/gmail). Accepts either
 * `Authorization: Bearer <JOB_SECRET>` (cron-job.org, the in-process queue) or, when
 * INVOKER_SERVICE_ACCOUNT is set, a Google OIDC token for that account (Cloud Scheduler/Tasks, Pub/Sub).
 */
export function oidcPreHandler(
  deps: Pick<Deps, "config" | "log">,
  verify: IdTokenVerifier = googleVerifier,
): preHandlerHookHandler {
  return async (request, reply) => {
    const { config } = deps;
    if (config.DEV_SKIP_OIDC) return;
    const path = request.url.split("?")[0] ?? "";
    const auth = request.headers.authorization;
    if (matchesBearerSecret(auth, config.JOB_SECRET)) return;
    if (config.INVOKER_SERVICE_ACCOUNT) {
      const audience = `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}${path}`;
      if (await verifyGoogleOidc(auth, { audience, email: config.INVOKER_SERVICE_ACCOUNT }, verify)) return;
    }
    deps.log.warn("oidc rejected", { path });
    await reply.code(401).send({ error: "unauthorized" });
  };
}
