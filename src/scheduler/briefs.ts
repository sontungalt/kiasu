import type { Deps } from "../ports.js";
import type { Store } from "../store/types.js";
import type { StateDocs } from "../types.js";
import { sgtAt, sgtDateKey } from "../lib/clock.js";
import { gatherBriefInput, type BriefKind } from "../brief/gather.js";
import { composeMorning } from "../brief/morning.js";
import { composeEvening } from "../brief/evening.js";
import { markAlerted, pruneHeldAlerts } from "../notify/held.js";

const NO_BRIEFS: StateDocs["briefs"] = { lastMorningDate: null, lastEveningDate: null };

async function markBriefDone(store: Store, kind: BriefKind, dateKey: string): Promise<void> {
  const cur = (await store.state.get("briefs")) ?? NO_BRIEFS;
  await store.state.set("briefs", kind === "morning" ? { ...cur, lastMorningDate: dateKey } : { ...cur, lastEveningDate: dateKey });
}

export async function maybeSendBrief(
  deps: Pick<Deps, "store" | "calendar" | "outbox" | "log">,
  kind: BriefKind,
  now: Date,
): Promise<"ok" | "skipped"> {
  const { store } = deps;
  const settings = await store.settings.get();
  const today = sgtDateKey(now);
  const briefs = (await store.state.get("briefs")) ?? NO_BRIEFS;
  if ((kind === "morning" ? briefs.lastMorningDate : briefs.lastEveningDate) === today) return "skipped";

  const scheduled = sgtAt(today, kind === "morning" ? settings.morningAt : settings.eveningAt);
  if (now.getTime() < scheduled.getTime()) return "skipped";

  if (kind === "morning" && now.getTime() >= sgtAt(today, settings.eveningAt).getTime()) {
    await markBriefDone(store, "morning", today);
    deps.log.warn("morning brief skipped: evening already due", { date: today });
    return "skipped";
  }

  const input = await gatherBriefInput(deps, kind, now);
  const brief = kind === "morning" ? composeMorning(input, now) : composeEvening(input, now);
  const nowIso = now.toISOString();

  // Claim as late as possible: a gather failure above leaves the brief unclaimed for the next tick.
  if (!(await store.processed.claim(`brief:${kind}:${today}`, nowIso))) return "skipped";

  await deps.outbox.deliver({ kind, text: brief.text, template: brief.template });
  await store.state.set("lastList", { at: nowIso, map: brief.numbering });
  await markBriefDone(store, kind, today);
  // Overnight alerts are covered by this brief. Stamp them just before the scheduled morning time so the
  // evening's "Urgent since this morning" (alertedAt >= today's morningAt) doesn't repeat them.
  const overnightStamp = kind === "morning" ? new Date(scheduled.getTime() - 1).toISOString() : nowIso;
  await markAlerted(store, input.overnightAlerts.map((i) => i.id), overnightStamp);
  await pruneHeldAlerts(store);
  deps.log.info("brief sent", { kind, date: today, ...brief.counts });
  return "ok";
}
