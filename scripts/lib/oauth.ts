/** Pure helpers for scripts/auth-google.ts. */
import type { AccountId } from "../../src/types.js";

export type SaveTarget = "auto" | "env" | "secret" | "both";

export interface AuthArgs {
  account: AccountId;
  to: SaveTarget;
}

export const AUTH_USAGE = "Usage: npm run auth -- personal|school [--to=auto|env|secret|both]";

export function parseAccountArg(argv: string[]): AccountId {
  const account = argv.find((a) => !a.startsWith("--"));
  if (account !== "personal" && account !== "school") throw new Error(AUTH_USAGE);
  return account;
}

export function parseAuthArgs(argv: string[]): AuthArgs {
  const account = parseAccountArg(argv);
  const toFlag = argv.find((a) => a.startsWith("--to="));
  const to = toFlag ? toFlag.slice("--to=".length) : "auto";
  if (to !== "auto" && to !== "env" && to !== "secret" && to !== "both") throw new Error(AUTH_USAGE);
  return { account, to };
}

export function refreshTokenKey(account: AccountId): "GOOGLE_REFRESH_TOKEN_PERSONAL" | "GOOGLE_REFRESH_TOKEN_SCHOOL" {
  return account === "personal" ? "GOOGLE_REFRESH_TOKEN_PERSONAL" : "GOOGLE_REFRESH_TOKEN_SCHOOL";
}

/**
 * Scopes Google reports under another name. Granting classroom.coursework.me.readonly shows up in the
 * token as its older alias classroom.student-submissions.me.readonly.
 */
export const SCOPE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly": [
    "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
  ],
};

export function scopeReport(
  requested: readonly string[],
  granted: readonly string[] | string | undefined,
): { granted: string[]; missing: string[] } {
  const list = typeof granted === "string" ? granted.split(/\s+/).filter(Boolean) : [...(granted ?? [])];
  const has = (scope: string) => list.includes(scope) || (SCOPE_ALIASES[scope] ?? []).some((a) => list.includes(a));
  return {
    granted: requested.filter(has),
    missing: requested.filter((s) => !has(s)),
  };
}

/** Warnings about a token response. Google only sets refresh_token_expires_in when the refresh token will expire. */
export function tokenWarnings(tokens: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (!tokens.refresh_token) {
    out.push(
      "No refresh token was returned. Remove the app at https://myaccount.google.com/permissions for this account, then run auth again.",
    );
  }
  const expiresIn = tokens.refresh_token_expires_in;
  if (typeof expiresIn === "number") {
    const days = Math.round(expiresIn / 86_400);
    out.push(
      `This refresh token expires in about ${days} day(s). If the OAuth consent screen is in "Testing", ` +
        `publish it ("In production", docs/setup.md step 3) and run auth again.`,
    );
  }
  return out;
}

/** Sets KEY=value in .env content, replacing an existing line or appending one. Other lines are untouched. */
export function upsertEnvLine(content: string, key: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${key} value must be a single line`);
  const line = `${key}=${value}`;
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  return lines.join("\n") + "\n";
}

export type CallbackResult = { kind: "code"; code: string } | { kind: "error"; error: string } | { kind: "ignore" };

/** Reads a request to the loopback redirect URI (http://127.0.0.1:<port>/). */
export function readCallback(url: URL, expectedState: string): CallbackResult {
  if (url.pathname !== "/") return { kind: "ignore" };
  const error = url.searchParams.get("error");
  if (error) return { kind: "error", error };
  const code = url.searchParams.get("code");
  if (!code) return { kind: "ignore" };
  if (url.searchParams.get("state") !== expectedState) {
    return { kind: "error", error: "state mismatch (possible CSRF); run auth again" };
  }
  return { kind: "code", code };
}
