import { isInvalidGrant } from "../../src/google/auth.js";
import type { AccountId, AccountState } from "../../src/types.js";

/**
 * Judges the account state AFTER MailService.renewWatchIfNeeded. That call does not throw on a
 * revoked token (it marks the account revoked and returns), so success must be read from the state.
 */
export function watchOutcome(account: AccountId, state: AccountState | null, now: Date): { ok: boolean; detail: string } {
  if (state?.authStatus === "revoked") {
    return { ok: false, detail: `the refresh token was rejected. Run: npm run auth -- ${account}` };
  }
  const expiresMs = state?.watchExpiresAt ? Date.parse(state.watchExpiresAt) : Number.NaN;
  if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) {
    return { ok: false, detail: "no active watch was recorded (see the log lines above)" };
  }
  return { ok: true, detail: `watch expires ${state?.watchExpiresAt}` };
}

/** A human hint for the common users.watch failures (spec §13.4), or null. */
export function watchErrorHint(err: unknown, topic: string): string | null {
  if (isInvalidGrant(err)) return "The refresh token was rejected. Run: npm run auth -- personal|school";
  const message = err instanceof Error ? err.message : JSON.stringify(err);
  if (/not authorized|permission/i.test(message)) {
    return (
      `Gmail can't publish to ${topic}. Grant roles/pubsub.publisher on the topic to ` +
      "gmail-api-push@system.gserviceaccount.com: run npm run setup:gcp (it's idempotent)."
    );
  }
  if (/invalid topicname|not found|does not exist/i.test(message)) {
    return `Topic ${topic} doesn't exist or GMAIL_PUBSUB_TOPIC is wrong. Run npm run setup:gcp and redeploy.`;
  }
  return null;
}
