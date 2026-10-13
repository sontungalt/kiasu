import type { Deps, Notifier } from "../ports.js";
import type { Item, TemplateRef } from "../types.js";
import { isQuietTime } from "../lib/clock.js";
import { sortItems } from "../store/filter.js";
import { itemLine, moreLine, truncate } from "../brief/format.js";
import { MAX_ITEMS_PER_SECTION } from "../brief/builder.js";
import { addHeldAlerts, markAlerted } from "./held.js";

export const ALERT_SUMMARY_MAX = 60;

export interface ComposedAlert {
  text: string;
  numbering: Record<string, string>;
  template: TemplateRef;
}

export function composeAlert(items: Item[], now: Date): ComposedAlert {
  const sorted = sortItems(items);
  const numbering: Record<string, string> = {};
  const lines = sorted.slice(0, MAX_ITEMS_PER_SECTION).map((item, k) => {
    numbering[String(k + 1)] = item.id;
    return itemLine(k + 1, item, now, "relative");
  });
  if (sorted.length > MAX_ITEMS_PER_SECTION) lines.push(moreLine(sorted.length - MAX_ITEMS_PER_SECTION));
  const text = `${["⚠️ *Heads up*", ...lines].join("\n")}\n\n_Reply "done 1" when it's sorted._`;
  const summary = sorted.length === 1
    ? (sorted[0]?.title ?? "")
    : `${sorted.length} things: ${sorted.map((i) => i.title).join("; ")}`;
  return { text, numbering, template: { name: "heads_up", params: [truncate(summary, ALERT_SUMMARY_MAX)] } };
}

export function createNotifier(deps: Pick<Deps, "clock" | "log" | "store" | "outbox">): Notifier {
  return {
    async sendAlerts(items) {
      if (items.length === 0) return;
      const { store } = deps;
      const now = deps.clock.now();
      const nowIso = now.toISOString();

      const ids = [...new Set(items.map((i) => i.id))];
      const fresh = (await Promise.all(ids.map((id) => store.items.get(id))))
        .filter((i): i is Item => i !== null && i.status === "open" && i.alertedAt === null);
      if (fresh.length === 0) return;
      const freshIds = fresh.map((i) => i.id);

      const settings = await store.settings.get();
      if (isQuietTime(now, settings.quietStart, settings.quietEnd)) {
        await addHeldAlerts(store, freshIds);
        deps.log.info("alerts held for quiet hours", { count: freshIds.length });
        return;
      }

      const alert = composeAlert(fresh, now);
      try {
        await deps.outbox.deliver({ kind: "alert", text: alert.text, template: alert.template });
      } catch (err) {
        await addHeldAlerts(store, freshIds);
        throw err;
      }
      await store.state.set("lastList", { at: nowIso, map: alert.numbering });
      await markAlerted(store, freshIds, nowIso);
      deps.log.info("alerts sent", { count: freshIds.length });
    },
  };
}
