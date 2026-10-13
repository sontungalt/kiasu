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

export function oidcPreHandler(
  deps: Pick<Deps, "config" | "log">,
  verify: IdTokenVerifier = googleVerifier,
): preHandlerHookHandler {
  return async (request, reply) => {
    if (deps.config.DEV_SKIP_OIDC) return;
    const path = request.url.split("?")[0] ?? "";
    const audience = `${deps.config.PUBLIC_BASE_URL.replace(/\/$/, "")}${path}`;
    const ok = await verifyGoogleOidc(request.headers.authorization, { audience, email: deps.config.INVOKER_SERVICE_ACCOUNT }, verify);
    if (!ok) {
      deps.log.warn("oidc rejected", { path });
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
}
