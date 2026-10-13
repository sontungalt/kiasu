/**
 * Google OAuth for one account (spec §12): Desktop-client loopback flow, offline access, consent prompt, PKCE.
 * Prints which scopes were granted and stores the refresh token in .env and/or Secret Manager.
 *
 * Usage: npm run auth -- personal|school [--to=auto|env|secret|both]
 *   auto (default): always .env, plus Secret Manager if GCP_PROJECT is set and the secret exists.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { GOOGLE_SCOPES } from "../src/google/auth.js";
import {
  parseAuthArgs, readCallback, refreshTokenKey, scopeReport, tokenWarnings, upsertEnvLine, type SaveTarget,
} from "./lib/oauth.js";
import { fillFromSecretManager, projectFromEnv, secretExists, writeSecret } from "./lib/secrets.js";

const ENV_PATH = ".env";
const TIMEOUT_MS = 5 * 60_000;

function waitForCode(server: Server, redirectUri: string, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 5 minutes waiting for the browser sign-in."));
    }, TIMEOUT_MS);
    server.on("request", (req, res) => {
      const result = readCallback(new URL(req.url ?? "/", redirectUri), state);
      if (result.kind === "ignore") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(result.kind === "code"
        ? "Signed in. You can close this tab and go back to the terminal."
        : `Sign-in failed: ${result.error}`);
      clearTimeout(timer);
      server.close();
      if (result.kind === "code") resolve(result.code);
      else reject(new Error(`Google returned: ${result.error}`));
    });
  });
}

async function save(key: string, value: string, to: SaveTarget, project: string | null): Promise<string[]> {
  const where: string[] = [];
  let toSecret = to === "secret" || to === "both";
  if (to === "auto" && project) toSecret = await secretExists(key, project);
  if (toSecret) {
    if (!project) throw new Error("GCP_PROJECT isn't set, so the token can't go to Secret Manager. Use --to=env, or set GCP_PROJECT.");
    await writeSecret(key, value, project);
    where.push(`Secret Manager (${key} in ${project})`);
  }
  if (to !== "secret") {
    const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
    writeFileSync(ENV_PATH, upsertEnvLine(current, key, value), { mode: 0o600 });
    where.push(`.env (${key})`);
  }
  return where;
}

async function main(): Promise<number> {
  const { account, to } = parseAuthArgs(process.argv.slice(2));
  const project = projectFromEnv(process.env);
  await fillFromSecretManager(process.env, ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"], project);
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET aren't set. Create the Desktop OAuth client (docs/setup.md step 4) and put both in .env.");
    return 1;
  }

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const state = randomBytes(16).toString("hex");
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });

  console.log(`\nSign in with your ${account.toUpperCase()} Google account.`);
  console.log(`If Google says "Google hasn't verified this app", click Advanced, then "Go to … (unsafe)". It's your own app.`);
  console.log(`If it says "Access blocked" or mentions your administrator, the school blocks third-party apps: see docs/setup.md step 7.\n`);
  console.log(`${authUrl}\n`);
  if (process.platform === "darwin") spawn("open", [authUrl], { stdio: "ignore", detached: true }).unref();

  const code = await waitForCode(server, redirectUri, state);
  const { tokens } = await client.getToken({ code, codeVerifier });

  const { granted, missing } = scopeReport(GOOGLE_SCOPES, tokens.scope ?? undefined);
  console.log("\nScopes:");
  for (const s of granted) console.log(`  ✅ ${s}`);
  for (const s of missing) console.log(`  ❌ ${s} (not granted)`);
  for (const w of tokenWarnings(tokens as unknown as Record<string, unknown>)) console.warn(`\n⚠️  ${w}`);
  if (!tokens.refresh_token) return 1;

  const key = refreshTokenKey(account);
  const where = await save(key, tokens.refresh_token, to, project);
  console.log(`\nSaved the refresh token to: ${where.join(" and ")}. (The token itself is never printed.)`);
  if (where.some((w) => w.startsWith("Secret Manager"))) {
    console.log("If the service is already deployed, start a new revision so it picks up the new token:");
    console.log(`  gcloud run services update kiasu-assistant --region=asia-southeast1 --update-env-vars=SECRETS_REFRESHED_AT=$(date +%s)`);
  }
  console.log(`\nNext: npm run check:access -- ${account}`);
  return missing.length === 0 ? 0 : 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (err: unknown) => { console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; },
);
