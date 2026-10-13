import type { RouteRegistrar } from "../server.js";
import type { Deps } from "../ports.js";
import { oidcPreHandler, type IdTokenVerifier } from "../http/oidc.js";
import { createNotifier } from "../notify/notifier.js";
import { tick } from "./tick.js";

export function jobRoutes(verify?: IdTokenVerifier): RouteRegistrar {
  return (app, deps) => {
    // This scope never reads a body. Cloud Scheduler may POST an empty body with any content type.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "string" }, (_request, _body, done) => done(null, undefined));

    app.post("/jobs/tick", { preHandler: oidcPreHandler(deps, verify) }, async (request, reply) => {
      const { now: nowParam } = request.query as { now?: string };
      if (deps.config.DEV_SKIP_OIDC && nowParam) {
        const at = new Date(nowParam);
        if (Number.isNaN(at.getTime())) return reply.code(400).send({ error: "invalid now" });
        const devDeps: Deps = { ...deps, clock: { now: () => new Date(at.getTime()) } };
        devDeps.notifier = createNotifier(devDeps);
        deps.log.warn("tick with overridden time (DEV_SKIP_OIDC)", { now: at.toISOString() });
        return tick(devDeps, at);
      }
      return tick(deps);
    });
  };
}

export const registerJobRoutes: RouteRegistrar = jobRoutes();
