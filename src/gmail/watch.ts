import type { AccountId } from "../types.js";
import { HOUR_MS } from "../lib/clock.js";
import { getAccount, withGmail, type GmailCtx } from "./account.js";

export const WATCH_RENEW_LEAD_MS = 48 * HOUR_MS;

/**
 * Renews users.watch when it expires within 48h. Also bootstraps a new account (email + first historyId).
 * Without GMAIL_PUBSUB_TOPIC there is no push: it only records the account email (the tick polls via syncAccount).
 */
export async function renewWatch(ctx: GmailCtx, account: AccountId): Promise<void> {
  const topic = ctx.config.GMAIL_PUBSUB_TOPIC;
  if (!topic) return bootstrapEmail(ctx, account);
  const now = ctx.clock.now();
  const acc = await ctx.store.accounts.get(account);
  const expiresMs = acc?.watchExpiresAt ? Date.parse(acc.watchExpiresAt) : Number.NaN;
  const due = !acc || !acc.email || !Number.isFinite(expiresMs) || expiresMs < now.getTime() + WATCH_RENEW_LEAD_MS;
  if (!due) return;

  const out = await withGmail(ctx, account, async (gm) => {
    const email = acc?.email || (await gm.getProfile()).emailAddress.trim().toLowerCase();
    const res = await gm.watch(topic);
    const expMs = Number(res.expiration);
    const latest = await getAccount(ctx.store, account);
    const watchExpiresAt = Number.isFinite(expMs) && expMs > 0 ? new Date(expMs).toISOString() : null;
    await ctx.store.accounts.upsert({
      ...latest,
      email: latest.email || email,
      historyId: latest.historyId ?? (res.historyId || null),
      watchExpiresAt,
    });
    ctx.log.info("gmail watch renewed", { account, watchExpiresAt });
  });
  if (!out.ok) ctx.log.info("gmail watch not renewed", { account, reason: out.reason });
}

/** Polling mode: fetch the account email once. historyId stays null, so the first syncAccount lists recent mail. */
async function bootstrapEmail(ctx: GmailCtx, account: AccountId): Promise<void> {
  const acc = await ctx.store.accounts.get(account);
  if (acc?.email) return;
  const out = await withGmail(ctx, account, async (gm) => {
    const email = (await gm.getProfile()).emailAddress.trim().toLowerCase();
    const latest = await getAccount(ctx.store, account);
    await ctx.store.accounts.upsert({ ...latest, email: latest.email || email });
    ctx.log.info("gmail account email recorded (push disabled, polling)", { account });
  });
  if (!out.ok) ctx.log.info("gmail account email not recorded", { account, reason: out.reason });
}
