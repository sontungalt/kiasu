import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Deps } from "./ports.js";

export type RouteRegistrar = (app: FastifyInstance, deps: Deps) => void | Promise<void>;

export async function buildServer(deps: Deps, registrars: RouteRegistrar[]): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    deps.log.error("request failed", { err, path: request.url.split("?")[0] });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    void reply.code(status).send({ error: status === 500 ? "internal" : err.message });
  });

  app.get("/healthz", async () => ({ ok: true }));

  for (const register of registrars) {
    await app.register(async (scope) => {
      await register(scope, deps);
    });
  }
  await app.ready();
  return app;
}
