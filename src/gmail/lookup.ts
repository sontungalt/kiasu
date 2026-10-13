import { ACCOUNT_IDS, type AccountId, type EmailSearchHit, type ParsedEmail } from "../types.js";
import { errInfo, httpStatusOf } from "./api.js";
import { withGmail, type GmailCtx } from "./account.js";
import { parseGmailMessage, searchHitFromMessage } from "./parse.js";

/** Live Gmail search (q syntax) for the chat agent. Newest first across the chosen accounts. */
export async function searchEmails(
  ctx: GmailCtx,
  query: string,
  opts: { account?: AccountId; limit?: number } = {},
): Promise<EmailSearchHit[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10), 1), 25);
  const accounts: readonly AccountId[] = opts.account ? [opts.account] : ACCOUNT_IDS;
  const hits: EmailSearchHit[] = [];
  for (const account of accounts) {
    try {
      const out = await withGmail(ctx, account, async (gm) => {
        const found: EmailSearchHit[] = [];
        for (const ref of await gm.listMessages(query, limit)) {
          found.push(searchHitFromMessage(await gm.getMessage(ref.id, "metadata"), account));
        }
        return found;
      });
      if (out.ok) hits.push(...out.value);
    } catch (err) {
      ctx.log.warn("gmail search failed", { account, err: errInfo(err) });
    }
  }
  return hits.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

/** Fetches and parses one message live. Uses the stored account if we've seen it, else tries both. */
export async function readEmail(ctx: GmailCtx, emailId: string): Promise<ParsedEmail | null> {
  const rec = await ctx.store.emails.get(emailId);
  const order: readonly AccountId[] = rec ? [rec.account] : ACCOUNT_IDS;
  for (const account of order) {
    const out = await withGmail(ctx, account, async (gm) => {
      try {
        return parseGmailMessage(await gm.getMessage(emailId, "full"), account, ctx.clock.now());
      } catch (err) {
        const status = httpStatusOf(err);
        if (status === 404 || status === 400) return null;
        throw err;
      }
    });
    if (out.ok && out.value) return out.value;
  }
  return null;
}
