import { ACCOUNT_IDS, type AccountId, type Item } from "../types.js";
import { EMPTY_SYNC, type Deps, type MailService, type SyncResult } from "../ports.js";
import { isInvalidGrant } from "../google/auth.js";
import { triageEmail, type TriageFn } from "../triage/triage.js";
import {
  createGmailApiFactory, errInfo, httpStatusOf,
  type GmailApi, type GmailApiFactory, type GmailMessage, type MessageRef,
} from "./api.js";
import { parseGmailMessage } from "./parse.js";
import { getAccount, withGmail, type GmailCtx } from "./account.js";
import { ingestParsed, triageRecord, type ProcessCtx } from "./process.js";
import { renewWatch } from "./watch.js";
import { readEmail, searchEmails } from "./lookup.js";

export const RESYNC_QUERY = "in:inbox newer_than:3d";
export const RESYNC_MAX = 100;
export const DEFAULT_MAX_PER_SYNC = 40;

export interface MailServiceOptions {
  triage?: TriageFn;
  maxPerSync?: number;
}

const emptySync = (): SyncResult => ({ ...EMPTY_SYNC, alerts: [] });

/** Adds alerts, replacing an earlier copy of the same item with the newer one. */
function mergeAlerts(into: Item[], more: Item[]): void {
  for (const a of more) {
    const i = into.findIndex((x) => x.id === a.id);
    if (i >= 0) into[i] = a;
    else into.push(a);
  }
}

/** Gmail history ids are increasing decimal strings. Never move backwards. */
export function maxHistoryId(current: string | null, next: string): string | null {
  if (!/^\d+$/.test(next)) return current;
  if (!current || !/^\d+$/.test(current)) return next;
  return BigInt(next) > BigInt(current) ? next : current;
}

/** Runs tasks for the same account one at a time (push and tick can overlap in one instance). */
export function createAccountLock() {
  const tails = new Map<AccountId, Promise<unknown>>();
  return function serial<T>(account: AccountId, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(account) ?? Promise.resolve();
    const next = prev.then(fn);
    tails.set(account, next.catch(() => undefined));
    return next;
  };
}

async function fetchMessage(gm: GmailApi, id: string): Promise<GmailMessage | null> {
  try {
    return await gm.getMessage(id, "full");
  } catch (err) {
    if (httpStatusOf(err) === 404) return null; // deleted before we got to it
    throw err;
  }
}

export function createMailService(
  deps: Pick<Deps, "config" | "clock" | "log" | "store" | "anthropic" | "outbox">,
  api?: GmailApiFactory,
  opts: MailServiceOptions = {},
): MailService {
  const { store, clock, log } = deps;
  const gmail = api ?? createGmailApiFactory(deps.config);
  const triage: TriageFn =
    opts.triage ?? ((parsed, account, now) => triageEmail(deps.anthropic, deps.config.TRIAGE_MODEL, parsed, account, now));
  const maxPerSync = opts.maxPerSync ?? DEFAULT_MAX_PER_SYNC;
  const ctx: GmailCtx = { config: deps.config, clock, log, store, outbox: deps.outbox, gmail };
  const pctx: ProcessCtx = { clock, log, store, triage };
  const serial = createAccountLock();

  async function listNew(gm: GmailApi, account: AccountId, historyId: string | null): Promise<{ refs: MessageRef[]; historyId: string }> {
    if (historyId) {
      try {
        const h = await gm.listHistory(historyId);
        return { refs: h.added, historyId: h.historyId };
      } catch (err) {
        if (httpStatusOf(err) !== 404) throw err;
        log.warn("gmail historyId expired, resyncing last 3 days", { account });
      }
    }
    const profile = await gm.getProfile(); // take the new historyId before listing, so nothing slips between
    const refs = (await gm.listMessages(RESYNC_QUERY, RESYNC_MAX)).reverse(); // oldest first
    return { refs, historyId: profile.historyId };
  }

  async function syncOnce(account: AccountId): Promise<SyncResult> {
    const total = emptySync(); // outside withGmail so partial results survive a mid-run invalid_grant
    await withGmail(ctx, account, async (gm) => {
      const start = await getAccount(store, account);
      const { refs, historyId } = await listNew(gm, account, start.historyId);
      let processed = 0;
      let complete = true;
      for (const ref of refs) {
        if (await store.emails.get(ref.id)) continue;
        if (processed >= maxPerSync) {
          complete = false;
          log.warn("gmail sync capped, continuing next run", { account, maxPerSync });
          break;
        }
        try {
          const msg = await fetchMessage(gm, ref.id);
          if (!msg) continue;
          if (!(await store.processed.claim(`gm:${ref.id}`, clock.now().toISOString()))) continue;
          processed++;
          const parsed = parseGmailMessage(msg, account, clock.now());
          if (parsed.truncated) log.info("email text truncated for triage", { account, emailId: parsed.id });
          const r = await ingestParsed(pctx, parsed);
          total.fetched += r.fetched;
          total.triaged += r.triaged;
          mergeAlerts(total.alerts, r.alerts);
        } catch (err) {
          if (isInvalidGrant(err)) throw err;
          complete = false;
          log.error("gmail sync stopped early", { account, emailId: ref.id, err: errInfo(err) });
          break;
        }
      }
      const latest = await getAccount(store, account);
      await store.accounts.upsert({
        ...latest,
        historyId: complete ? maxHistoryId(latest.historyId, historyId) : latest.historyId,
        lastSyncAt: clock.now().toISOString(),
      });
      log.info("gmail sync done", { account, fetched: total.fetched, triaged: total.triaged, alerts: total.alerts.length, complete });
    });
    return total;
  }

  async function retryOne(id: string, account: AccountId): Promise<SyncResult | null> {
    const fresh = await store.emails.get(id);
    if (!fresh || fresh.triageStatus !== "pending") return null;
    const out = await withGmail(ctx, account, async (gm) => {
      const msg = await fetchMessage(gm, fresh.id);
      if (!msg) {
        await store.emails.upsert({ ...fresh, triageStatus: "skipped", processedAt: clock.now().toISOString() });
        log.info("pending email no longer exists", { account, emailId: fresh.id });
        return null;
      }
      return triageRecord(pctx, fresh, parseGmailMessage(msg, account, clock.now()));
    });
    return out.ok && out.value ? { fetched: 0, ...out.value } : null;
  }

  const syncAccount = (account: AccountId) => serial(account, () => syncOnce(account));

  return {
    syncAccount,

    async handlePush({ emailAddress }) {
      const addr = emailAddress.trim().toLowerCase();
      for (const id of ACCOUNT_IDS) {
        const acc = await store.accounts.get(id);
        if (acc?.email && acc.email.toLowerCase() === addr) return syncAccount(id);
      }
      log.warn("gmail push for an unknown address");
      return emptySync();
    },

    async retryPendingTriage(limit = 20) {
      const total = emptySync();
      for (const rec of await store.emails.listPending(limit)) {
        try {
          const r = await serial(rec.account, () => retryOne(rec.id, rec.account));
          if (r) {
            total.triaged += r.triaged;
            mergeAlerts(total.alerts, r.alerts);
          }
        } catch (err) {
          log.error("triage retry failed", { account: rec.account, emailId: rec.id, err: errInfo(err) });
        }
      }
      return total;
    },

    renewWatchIfNeeded: (account) => serial(account, () => renewWatch(ctx, account)),
    search: (query, o) => searchEmails(ctx, query, o),
    read: (emailId) => readEmail(ctx, emailId),
  };
}
