/**
 * Spec §13 step 0: with the stored refresh token, can this account reach Gmail, Calendar and Classroom?
 * Usage: npm run check:access -- personal|school
 * The token comes from .env, or from Secret Manager if .env doesn't have it.
 */
import { google } from "googleapis";
import { GOOGLE_SCOPES, isInvalidGrant } from "../src/google/auth.js";
import { parseAccountArg, refreshTokenKey, scopeReport } from "./lib/oauth.js";
import { adviceFor, classifyGoogleError, formatResult, okResult, type AccessResult, type ApiName } from "./lib/access.js";
import { fillFromSecretManager, projectFromEnv } from "./lib/secrets.js";

async function main(): Promise<number> {
  const account = parseAccountArg(process.argv.slice(2));
  const key = refreshTokenKey(account);
  await fillFromSecretManager(process.env, ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", key], projectFromEnv(process.env));
  const { GOOGLE_OAUTH_CLIENT_ID: id, GOOGLE_OAUTH_CLIENT_SECRET: secret } = process.env;
  const refreshToken = process.env[key];
  if (!id || !secret) {
    console.error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET aren't set (.env or Secret Manager).");
    return 1;
  }
  if (!refreshToken) {
    console.error(`No ${key} in .env or Secret Manager. Run: npm run auth -- ${account}`);
    return 1;
  }

  const auth = new google.auth.OAuth2(id, secret);
  auth.setCredentials({ refresh_token: refreshToken });

  try {
    const { token } = await auth.getAccessToken();
    const info = await auth.getTokenInfo(token ?? "");
    const { missing } = scopeReport(GOOGLE_SCOPES, info.scopes);
    console.log(missing.length === 0 ? "✅ all 5 scopes granted" : `⚠️  scopes not granted: ${missing.join(", ")}`);
  } catch (err) {
    if (isInvalidGrant(err)) {
      console.log(`❌ token rejected (invalid_grant). Run: npm run auth -- ${account}`);
    } else {
      console.log(`❌ couldn't get an access token: ${classifyGoogleError("gmail", err).reason}`);
    }
    return 1;
  }

  const probes: Record<ApiName, () => Promise<string>> = {
    gmail: async () =>
      `signed in as ${(await google.gmail({ version: "v1", auth }).users.getProfile({ userId: "me" })).data.emailAddress ?? "?"}`,
    calendar: async () =>
      `${(await google.calendar({ version: "v3", auth }).calendarList.list({ maxResults: 50 })).data.items?.length ?? 0} calendars`,
    classroom: async () =>
      `${(await google.classroom({ version: "v1", auth }).courses.list({ studentId: "me", pageSize: 20 })).data.courses?.length ?? 0} courses`,
  };

  const results: AccessResult[] = [];
  for (const api of ["gmail", "calendar", "classroom"] as const) {
    try {
      const detail = await probes[api]();
      results.push(okResult(api));
      console.log(`${formatResult(okResult(api))}  ${detail}`);
    } catch (err) {
      const r = classifyGoogleError(api, err);
      results.push(r);
      console.log(formatResult(r));
    }
  }
  console.log("");
  for (const line of adviceFor(account, results)) console.log(line);
  return results.every((r) => r.kind === "ok") ? 0 : 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; },
);
