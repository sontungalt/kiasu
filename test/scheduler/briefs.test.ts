import { describe, it, expect } from "vitest";
import { maybeSendBrief } from "../../src/scheduler/briefs.js";
import { addHeldAlerts, heldAlertIds } from "../../src/notify/held.js";
import { FOOTER } from "../../src/brief/builder.js";
import { makeSchedulerDeps } from "../helpers/scheduler-fakes.js";
import { makeItem } from "../store/contract.js";

const WED_0630 = "2026-10-13T22:30:00.000Z";
const at = (iso: string) => new Date(iso);

async function withDueTodayItem(nowIso: string) {
  const ctx = makeSchedulerDeps(nowIso);
  const item = await ctx.deps.store.items.create(makeItem({ dueAt: "2026-10-14T07:00:00.000Z" })); // Wed 15:00 SGT
  return { ...ctx, item };
}

describe("maybeSendBrief", () => {
  it("sends the morning brief at 06:30 exactly once and records it", async () => {
    const { deps, outbox, item } = await withDueTodayItem(WED_0630);
    expect(await maybeSendBrief(deps, "morning", at(WED_0630))).toBe("ok");
    expect(outbox.sent).toEqual([{
      kind: "morning",
      text: `*Good morning! Wed 14 Oct* ☀️\n\n*📌 Due today*\n1. Submit consent form · by 3pm · Mr Tan\n\n${FOOTER}`,
      template: { name: "brief_ready", params: ["Wed", "1", "0"] },
    }]);
    expect(await deps.store.state.get("lastList")).toEqual({ at: WED_0630, map: { "1": item.id } });
    expect(await deps.store.state.get("briefs")).toEqual({ lastMorningDate: "2026-10-14", lastEveningDate: null });
    expect(await maybeSendBrief(deps, "morning", at("2026-10-13T22:35:00.000Z"))).toBe("skipped");
    expect(outbox.sent).toHaveLength(1);
  });

  it("does nothing before morningAt", async () => {
    const { deps, outbox } = await withDueTodayItem("2026-10-13T22:25:00.000Z");
    expect(await maybeSendBrief(deps, "morning", at("2026-10-13T22:25:00.000Z"))).toBe("skipped");
    expect(outbox.sent).toEqual([]);
  });

  it("missed 06:30 tick: the 06:40 tick still sends it", async () => {
    const { deps, outbox } = await withDueTodayItem("2026-10-13T22:40:00.000Z");
    expect(await maybeSendBrief(deps, "morning", at("2026-10-13T22:40:00.000Z"))).toBe("ok");
    expect(outbox.sent.map((m) => m.kind)).toEqual(["morning"]);
  });

  it("after eveningAt the morning brief is skipped, not sent late", async () => {
    const now = at("2026-10-14T13:05:00.000Z"); // Wed 21:05 SGT
    const { deps, outbox } = await withDueTodayItem(now.toISOString());
    expect(await maybeSendBrief(deps, "morning", now)).toBe("skipped");
    expect((await deps.store.state.get("briefs"))?.lastMorningDate).toBe("2026-10-14");
    expect(await maybeSendBrief(deps, "evening", now)).toBe("ok");
    expect(outbox.sent.map((m) => m.kind)).toEqual(["evening"]);
    expect(outbox.sent[0]?.text).toContain("*Evening check-in · Wed 14 Oct* 🌙");
    expect(outbox.sent[0]?.text).toContain("*⏳ Still open from today*\n1. Submit consent form (was due 3pm) · Mr Tan");
  });

  it("overlapping ticks send the brief once", async () => {
    const { deps, outbox } = await withDueTodayItem(WED_0630);
    const results = await Promise.all([
      maybeSendBrief(deps, "morning", at(WED_0630)),
      maybeSendBrief(deps, "morning", at(WED_0630)),
    ]);
    expect([...results].sort()).toEqual(["ok", "skipped"]);
    expect(outbox.sent.filter((m) => m.kind === "morning")).toHaveLength(1);
  });

  it("folds held overnight alerts in, marks them alerted and clears the held list", async () => {
    const { deps, outbox } = makeSchedulerDeps(WED_0630);
    const camp = await deps.store.items.create(makeItem({ title: "Camp form", urgency: "urgent", dedupeKey: "camp" }));
    const gone = await deps.store.items.create(makeItem({ title: "Gone", status: "done", dedupeKey: "gone" }));
    await addHeldAlerts(deps.store, [camp.id, gone.id]);
    expect(await maybeSendBrief(deps, "morning", at(WED_0630))).toBe("ok");
    expect(outbox.sent[0]?.text).toContain("*🌙 Came in overnight*\n1. Camp form · Mr Tan");
    expect(outbox.sent[0]?.template.params).toEqual(["Wed", "0", "1"]);
    expect((await deps.store.items.get(camp.id))?.alertedAt).toBe(WED_0630);
    expect(await heldAlertIds(deps.store)).toEqual([]);
  });
});
