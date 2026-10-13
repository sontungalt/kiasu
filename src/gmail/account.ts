import type { Deps, OutboundMessage } from "../ports.js";
import type { Store } from "../store/types.js";
import type { AccountId, AccountState } from "../types.js";
import { isInvalidGrant } from "../google/auth.js";
import { errInfo, type GmailApi, type GmailApiFactory } from "./api.js";

export type GmailDeps = Pick<Deps, "config" | "clock" | "log" | "store" | "outbox">;

export interface GmailCtx extends GmailDeps {
  gmail: GmailApiFactory;
}

export type GmailOutcome<T> = { ok: true; value: T } | { ok: false; reason: "no_token" | "revoked" };

export function blankAccount(id: AccountId): AccountState {
  return { id, email: "", historyId: null, watchExpiresAt: null, lastSyncAt: null, authStatus: "ok" };
}

export async function getAccount(store: Store, id: AccountId): Promise<AccountState> {
  return (await store.accounts.get(id)) ?? blankAccount(id);
}

export function reconnectMessage(account: AccountId): OutboundMessage {
  return {
    kind: "system",
    text:
      `Heads up: I can't read your ${account} Gmail any more. Google says the sign-in was revoked or has expired.\n` +
      `To reconnect, run \`npm run auth -- ${account}\`. Your other account keeps working.`,
    template: { name: "heads_up", params: [`Reconnect your ${account} Google account`] },
  };
}

/** Sets authStatus "revoked". Sends the reconnect notice only on the ok→revoked transition. */
export async function markRevoked(ctx: GmailCtx, account: AccountId): Promise<void> {
  const acc = await getAccount(ctx.store, account);
  if (acc.authStatus === "revoked") return;
  await ctx.store.accounts.upsert({ ...acc, authStatus: "revoked" });
  ctx.log.error("gmail auth revoked", { account });
  try {
    await ctx.outbox.deliver(reconnectMessage(account));
  } catch (err) {
    ctx.log.error("reconnect notice failed", { account, err: errInfo(err) });
  }
}

/**
 * Runs fn with the account's GmailApi.
 * - no refresh token → { ok: false, reason: "no_token" } (fn not called)
 * - invalid_grant thrown → account marked revoked → { ok: false, reason: "revoked" }
 * - any other error → rethrown
 * - success → a previously revoked account is set back to "ok"
 */
export async function withGmail<T>(
  ctx: GmailCtx,
  account: AccountId,
  fn: (api: GmailApi) => Promise<T>,
): Promise<GmailOutcome<T>> {
  const api = ctx.gmail(account);
  if (!api) return { ok: false, reason: "no_token" };
  let value: T;
  try {
    value = await fn(api);
  } catch (err) {
    if (!isInvalidGrant(err)) throw err;
    await markRevoked(ctx, account);
    return { ok: false, reason: "revoked" };
  }
  const acc = await ctx.store.accounts.get(account); // re-read: fn may have written the account
  if (acc?.authStatus === "revoked") {
    await ctx.store.accounts.upsert({ ...acc, authStatus: "ok" });
    ctx.log.info("gmail auth restored", { account });
  }
  return { ok: true, value };
}
