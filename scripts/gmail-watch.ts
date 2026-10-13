/**
 * Starts or renews the Gmail push watch for both accounts against PRODUCTION Firestore (spec §13.4).
 * Usage: npm run gmail:watch  (deploy.sh runs it). Needs `gcloud auth application-default login`.
 * Missing values in .env are filled from Secret Manager. Use --emulator to target FIRESTORE_EMULATOR_HOST instead.
 */
import { loadConfig } from "../src/config.js";
import { buildDeps } from "../src/app.js";
import { googleAuthFor } from "../src/google/auth.js";
import { ACCOUNT_IDS } from "../src/types.js";
import { ALL_SECRET_KEYS, fillFromSecretManager, projectFromEnv } from "./lib/secrets.js";
import { watchErrorHint, watchOutcome } from "./lib/watch.js";

async function main(): Promise<number> {
  const useEmulator = process.argv.includes("--emulator");
  if (process.env.FIRESTORE_EMULATOR_HOST && !useEmulator) {
    console.error("FIRESTORE_EMULATOR_HOST is set, so the watch state would go to the emulator. Unset it, or pass --emulator.");
    return 1;
  }
  const filled = await fillFromSecretManager(process.env, ALL_SECRET_KEYS, projectFromEnv(process.env));
  if (filled.length > 0) console.log(`Filled from Secret Manager: ${filled.join(", ")}`);
  const config = loadConfig({ ...process.env, NODE_ENV: "development", DEV_SKIP_OIDC: "false" });
  const { deps } = buildDeps(config, { env: { STORE: "firestore" } });

  let failures = 0;
  for (const account of ACCOUNT_IDS) {
    if (!googleAuthFor(account, config)) {
      console.log(`- ${account}: no refresh token, skipped (npm run auth -- ${account})`);
      continue;
    }
    try {
      await deps.mail.renewWatchIfNeeded(account);
      const outcome = watchOutcome(account, await deps.store.accounts.get(account), deps.clock.now());
      if (!outcome.ok) failures++;
      console.log(`${outcome.ok ? "✅" : "❌"} ${account}: ${outcome.detail}`);
    } catch (err) {
      failures++;
      console.log(`❌ ${account}: ${err instanceof Error ? err.message : String(err)}`);
      const hint = watchErrorHint(err, config.GMAIL_PUBSUB_TOPIC);
      if (hint) console.log(`   ${hint}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
