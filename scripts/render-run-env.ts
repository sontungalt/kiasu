/**
 * Writes the Cloud Run env-vars YAML used by scripts/deploy.sh. Prints key names only.
 * Usage: tsx scripts/render-run-env.ts --env-file=.env --public-base-url=URL --project=P --region=R --out=FILE
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { buildRunEnv, toEnvYaml } from "./lib/deploy-env.js";

function arg(name: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  if (!hit) throw new Error(`Missing ${prefix}…`);
  return hit.slice(prefix.length);
}

const dotenv = parseEnv(readFileSync(arg("env-file"), "utf8"));
const env = buildRunEnv(dotenv, { publicBaseUrl: arg("public-base-url"), project: arg("project"), region: arg("region") });
writeFileSync(arg("out"), toEnvYaml(env), { mode: 0o600 });
console.error(`Plain env vars for Cloud Run (no secrets): ${Object.keys(env).join(", ")}`);
