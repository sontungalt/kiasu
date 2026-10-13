import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

/** Cloud Run sends SIGTERM and waits 10s before SIGKILL. */
const SHUTDOWN_GRACE_MS = 8_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, deps } = await buildApp(config);
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  deps.log.info("listening", { port: config.PORT, nodeEnv: config.NODE_ENV, devSkipOidc: config.DEV_SKIP_OIDC });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    deps.log.info("shutting down", { signal });
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        deps.log.error("shutdown failed", { err });
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // Config errors list variable names only, never values.
  console.error(JSON.stringify({ severity: "ERROR", message: "startup failed", error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
