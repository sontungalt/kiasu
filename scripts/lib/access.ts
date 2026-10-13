/** Pure classification of Google API probe results for scripts/check-access.ts (spec §13 step 0). */
import { isInvalidGrant } from "../../src/google/auth.js";
import type { AccountId } from "../../src/types.js";

export type ApiName = "gmail" | "calendar" | "classroom";
export type AccessKind = "ok" | "invalid_grant" | "scope_missing" | "api_not_enabled" | "blocked_by_admin" | "other";

export interface AccessResult {
  api: ApiName;
  kind: AccessKind;
  status: number | null;
  reason: string;
}

interface GaxiosLike {
  message?: string;
  status?: number;
  code?: number | string;
  response?: {
    status?: number;
    data?: {
      error?:
        | string
        | {
            message?: string;
            status?: string;
            errors?: Array<{ reason?: string; message?: string }>;
            details?: Array<{ reason?: string }>;
          };
      error_description?: string;
    };
  };
}

export function okResult(api: ApiName): AccessResult {
  return { api, kind: "ok", status: 200, reason: "" };
}

export function classifyGoogleError(api: ApiName, err: unknown): AccessResult {
  const e = (err ?? {}) as GaxiosLike;
  const status = e.response?.status ?? (typeof e.code === "number" ? e.code : null) ?? e.status ?? null;
  const body = e.response?.data?.error;
  const apiError = typeof body === "object" && body !== null ? body : undefined;
  const message = apiError?.message ?? e.response?.data?.error_description ?? e.message ?? String(err);
  const reasons = [
    ...(apiError?.errors ?? []).map((x) => x.reason ?? ""),
    ...(apiError?.details ?? []).map((x) => x.reason ?? ""),
    apiError?.status ?? "",
  ].join(" ");
  const text = `${reasons} ${message}`;

  let kind: AccessKind;
  if (isInvalidGrant(err)) kind = "invalid_grant";
  else if (/insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(text)) kind = "scope_missing";
  else if (/SERVICE_DISABLED|accessNotConfigured|has not been used in project/i.test(text)) kind = "api_not_enabled";
  else if (
    (status === 403 || status === 400) &&
    /admin|domain|not enabled for|disabled for|policy|service not enabled|ClassroomApiDisabled|failedPrecondition|FAILED_PRECONDITION/i.test(text)
  ) kind = "blocked_by_admin";
  else kind = "other";

  return { api, kind, status, reason: message.slice(0, 300) };
}

export function formatResult(r: AccessResult): string {
  if (r.kind === "ok") return `✅ ${r.api}`;
  return `❌ ${r.api}: ${r.kind}${r.status ? ` (${r.status})` : ""}: ${r.reason}`;
}

export function adviceFor(account: AccountId, results: AccessResult[]): string[] {
  const by = (api: ApiName) => results.find((r) => r.api === api);
  const failed = results.filter((r) => r.kind !== "ok");
  if (failed.length === 0) return [`All good: the ${account} account can reach Gmail, Calendar and Classroom.`];

  const blocked = (r: AccessResult | undefined) => !!r && (r.kind === "blocked_by_admin" || r.kind === "other");
  const out: string[] = [];
  if (failed.some((r) => r.kind === "invalid_grant")) {
    out.push(`The refresh token was rejected (invalid_grant). Run: npm run auth -- ${account}`);
  }
  if (failed.some((r) => r.kind === "api_not_enabled")) {
    out.push(
      "An API is disabled in your GCP project. Run: npm run setup:gcp  " +
        "(or: gcloud services enable gmail.googleapis.com calendar-json.googleapis.com classroom.googleapis.com)",
    );
  }
  if (failed.some((r) => r.kind === "scope_missing")) {
    out.push(`Some permissions weren't granted. Run npm run auth -- ${account} again and tick every checkbox on the consent screen.`);
  }
  const gmail = by("gmail");
  if (blocked(gmail)) {
    out.push(
      'Gmail is blocked for this account. Use a fallback (spec §13, docs/setup.md "If the school account is blocked"):',
      "  (a) Gmail auto-forward from this account to your personal Gmail, with a filter label so triage can still tag it school.",
      "  (b) A Google Apps Script inside this account that posts new-mail summaries to the service (first-party, often allowed).",
    );
  }
  if (blocked(by("classroom")) && gmail?.kind === "ok") {
    out.push("Only Classroom is blocked. Set CLASSROOM_ENABLED=false in .env (and redeploy). Gmail and Calendar keep working.");
  }
  if (blocked(by("calendar"))) {
    out.push("Calendar is blocked for this account. Briefs won't show its events. Everything else still works.");
  }
  return out;
}
