# Kiasu: Plan 04, Briefs, Notifier and Scheduler

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build everything time-based. That means the WhatsApp formatting helpers, the morning brief and evening check-in composers (pure functions), the brief data gatherer, the alert `Notifier` (quiet hours, grouping), the nudge sender, the brief sender, the 5-minute `tick`, and the `POST /jobs/tick` route.

**Architecture:** `src/brief/*` is pure text composition plus one gatherer that reads the store and calendar. `src/notify/*` owns alert delivery and the "held during quiet hours" list. `src/scheduler/*` runs the steps in order: `tick` calls the mail, classroom, outbox and store services only through the `Deps` ports from plan 00. Every step has its own try/catch, and the results go into a `TickReport`.

**Tech Stack:** Node 24, TypeScript ~5.9 (NodeNext ESM, so relative imports end in `.js`), Fastify 5, vitest 5. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-13-kiasu-design.md` (§6, §7a, §8.1–8.5, §10, §11). Shared contracts: `docs/superpowers/plans/2026-10-13-00-foundation.md`.

**Plan set:** This is plan **04 of 07**. It runs **in parallel** with plans 01, 02, 03, 05 and 06 (tasks 1–4) after plan 00, in its own worktree. The mail, calendar, classroom and outbox services come from sibling plans. Tests here never import sibling code. They pass small fakes to `makeTestDeps({...})` instead (`test/helpers/scheduler-fakes.ts`, created in Task 5).

---

## Contract change (apply once on main, plan 00 files)

Two additive changes. Nothing that already exists is renamed or removed.

1. **`src/types.ts` → `StateDocs` gains `heldAlerts: { itemIds: string[] }`.**
   *Why:* §8.3 says alerts are "held and folded into the morning brief" during quiet hours. An item that was held looks exactly like any other item with `alertedAt: null`, and the alert decision depends on email importance and VIP status, which aren't stored on the item. So the brief can't work out afterwards which items were held. The notifier writes their IDs here, and the brief reads them back and clears them. Only plan 04 reads or writes this doc. `MemoryStore` and `FirestoreStore` are generic over `StateDocs` keys, so they need no code change.
2. **`Store.emails` gains `listFailedSince(sinceIso: string): Promise<EmailRecord[]>`.** It returns emails where `triageStatus === "failed"` and `processedAt >= since`, newest first.
   *Why:* §7 needs the brief to say "1 email couldn't be read automatically: *subject*". The current `Store` has no way to query failed emails (`listImportantSince` filters on `done`). This needs small implementations in `MemoryStore` and `FirestoreStore` and one new contract test. All three are in Task 1.

Task 1 applies both changes in this worktree so everything compiles. If the coordinator has already applied them on main before you start (check with `grep -n heldAlerts src/types.ts`), skip Task 1.

**Wiring note for plan 06 (composition root):** `createNotifier` needs `deps.outbox`, so build it after the rest of `deps`, then assign it: `deps.notifier = createNotifier(deps)`. Register `registerJobRoutes` with `buildServer`.

---

## Global Constraints

- Timezone is **Asia/Singapore (UTC+8, no DST)**. Every stored timestamp is a UTC ISO string ending in `Z`. Day boundaries are computed in SGT with the plan 00 helpers (`sgtDateKey`, `sgtAt`, `addDaysToKey`). Never use `getHours()` or the local machine timezone.
- Default settings (`DEFAULT_SETTINGS`): `morningAt: "06:30"`, `eveningAt: "21:00"`, `quietStart: "22:30"`, `quietEnd: "06:30"`, `urgentWindowHours: 36`, `nudgeLeadHours: 3`. Always read them with `store.settings.get()`, never hard-code them.
- Briefs are **composed by code, with no AI** (§8.2). Sections are left out when empty. Items are numbered continuously, and the numbering is saved to `state/lastList` so "done 2" works.
- WhatsApp formatting: `*bold*`, `_italic_`, short lines, no tables (§9). The WhatsApp client (plan 03) splits text over 4096 characters, but a brief should stay well under that.
- Templates (§8.1), used exactly: `brief_ready` = `📚 Your {{1}} brief is ready: {{2}} due today, {{3}} urgent.` and `heads_up` = `⚠️ Heads up: {{1}}`. `heads_up` covers alerts, reminders and nudges.
- Quiet hours (§8.4): **reminders ignore them**. Alerts and nudges are held. A nudge whose deadline passes during quiet hours is dropped, and the item shows as overdue in the morning brief.
- Each tick step is wrapped in its own try/catch (§8.5, §10). One failure is logged and reported, and the remaining steps still run.
- Never log email bodies. Log IDs, counts and error messages.
- Relative imports use the `.js` suffix. Use the plan 00 names exactly (`Item`, `EmailRecord`, `CalendarEvent`, `Settings`, `StateDocs`, `TemplateRef`, `Deps`, `Notifier`, `Outbox`, `OutboundMessage`, `SyncResult`, `EMPTY_SYNC`, `Store`, `sortItems`, `makeTestDeps`, `makeItem`).
- Every task ends with `npm test` and `npm run typecheck` passing.

## Review Focus

1. **Missed 06:30 tick (Cloud Run cold start or outage).** If the first tick of the morning runs at 06:40, it must still send the morning brief. If nothing runs until after 21:00, the morning brief is skipped for that day and only the evening one goes out, so two briefs never arrive back to back. *Pinned by:* the Task 8 tests `missed 06:30 tick: the 06:40 tick still sends it` and `after eveningAt the morning brief is skipped, not sent late`.
2. **Two overlapping ticks** (a Scheduler retry while a slow tick is still running). Both read `state/briefs` before either writes it. The brief must still go out exactly once, which is done by claiming `brief:<kind>:<dateKey>` with `store.processed.claim` just before delivering. *Pinned by:* the Task 8 test `overlapping ticks send the brief once`.
3. **40 open items.** The brief must stay readable and under WhatsApp's 4096-character limit. Each section shows at most 8 items plus "…and N more", the template counts stay accurate (40 due today), and the first sync after setup can't flood the user with one giant alert. *Pinned by:* the Task 3 test `40 open items: sections are capped, counts stay true, text stays short`, and the Task 5 test `caps a large batch at 8 lines`.
4. **An item due exactly at midnight SGT** (`…T16:00:00Z`). People mean "end of that day", so on Wednesday it shows under *Due today* as "by midnight", not under Thursday. *Pinned by:* the Task 2 test `midnight belongs to the day before`, and the Task 3 test `an item due exactly at midnight counts as due the day before`.
5. **A snoozed item that's also overdue.** It stays out of briefs while it's snoozed. When `snoozedUntil` passes, the tick reopens it and it appears under *Overdue*. It's never nudged, because overdue items aren't nagged. *Pinned by:* the Task 9 test `snoozed + overdue item stays hidden until woken, then shows as overdue and is never nudged`.

---

## File map

```
src/types.ts                         # MODIFY (contract change): StateDocs.heldAlerts
src/store/types.ts                   # MODIFY (contract change): emails.listFailedSince
src/store/memory.ts                  # MODIFY (contract change)
src/store/firestore.ts               # MODIFY (contract change)
src/brief/format.ts                  # WhatsApp formatting helpers (pure)
src/brief/builder.ts                 # BriefInput, ComposedBrief, BriefBuilder (numbering + sections)
src/brief/morning.ts                 # composeMorning (pure)
src/brief/evening.ts                 # composeEvening (pure)
src/brief/gather.ts                  # gatherBriefInput, healthLines
src/notify/held.ts                   # held-alerts list helpers
src/notify/notifier.ts               # createNotifier, composeAlert
src/scheduler/nudges.ts              # sendNudges, composeNudge
src/scheduler/briefs.ts              # maybeSendBrief
src/scheduler/tick.ts                # tick, TickReport
src/scheduler/routes.ts              # registerJobRoutes, jobRoutes
test/store/contract.ts               # MODIFY (contract change): one new test
test/brief/fixtures.ts               # shared fixtures for brief tests
test/helpers/scheduler-fakes.ts      # fake mail/calendar/classroom/outbox + makeSchedulerDeps
test/brief/{format,morning,evening,gather}.test.ts
test/notify/notifier.test.ts
test/scheduler/{nudges,briefs,tick,routes}.test.ts
```

---

### Task 1: Contract change: `heldAlerts` state and `emails.listFailedSince`

**Files:**
- Modify: `src/types.ts` (the `StateDocs` interface)
- Modify: `src/store/types.ts` (the `emails` block of `Store`)
- Modify: `src/store/memory.ts` (the `emails` repository)
- Modify: `src/store/firestore.ts` (the `emails` repository)
- Modify: `test/store/contract.ts` (add one test inside `runStoreContract`)

**Interfaces:**
- Consumes: plan 00 `Store`, `MemoryStore`, `FirestoreStore`, `runStoreContract`.
- Produces: `StateDocs["heldAlerts"] = { itemIds: string[] }`, `Store.emails.listFailedSince(sinceIso: string): Promise<EmailRecord[]>`.

- [x] **Step 1: Write the failing contract test**

In `test/store/contract.ts`, add this test inside the `describe` in `runStoreContract`, directly after the existing `it("emails pending and important-since", ...)`:

```ts
    it("emails failed-since", async () => {
      const base = {
        account: "school" as const, threadId: "t", from: "f", subject: "s", summary: null, category: null,
        importance: null, needsReply: false, triageAttempts: 5, receivedAt: "2026-10-14T01:00:00.000Z",
      };
      await store.emails.upsert({ ...base, id: "f1", triageStatus: "failed", processedAt: "2026-10-14T03:00:00.000Z" });
      await store.emails.upsert({ ...base, id: "f2", triageStatus: "failed", processedAt: "2026-10-14T04:00:00.000Z",
        receivedAt: "2026-10-14T02:00:00.000Z" });
      await store.emails.upsert({ ...base, id: "f0", triageStatus: "failed", processedAt: "2026-10-12T03:00:00.000Z" });
      await store.emails.upsert({ ...base, id: "d1", triageStatus: "done", processedAt: "2026-10-14T03:00:00.000Z" });
      expect((await store.emails.listFailedSince("2026-10-14T00:00:00.000Z")).map((e) => e.id)).toEqual(["f2", "f1"]);
    });
```

- [x] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run test/store/memory.test.ts`
Expected: FAIL in `emails failed-since` with `store.emails.listFailedSince is not a function`. Typecheck would also fail on the unknown method.

- [x] **Step 3: Apply the contract changes**

`src/types.ts`: replace the `StateDocs` interface with:

```ts
/** Singleton state documents, keyed by name. */
export interface StateDocs {
  whatsapp: { lastInboundAt: string | null };
  lastList: { at: string; map: Record<string, string> }; // "1" -> itemId
  briefs: { lastMorningDate: string | null; lastEveningDate: string | null }; // SGT date keys
  classroom: { lastSyncAt: string | null };
  heldAlerts: { itemIds: string[] }; // alert-worthy items held during quiet hours (plan 04)
}
```

`src/store/types.ts`: in the `emails` block, add this line after `listImportantSince`:

```ts
    listFailedSince(sinceIso: string): Promise<EmailRecord[]>; // triageStatus === "failed", processedAt >= since, newest first
```

`src/store/memory.ts`: in `emails: Store["emails"] = { ... }`, add after `listImportantSince`:

```ts
    listFailedSince: async (since) =>
      clone([...this.emailMap.values()]
        .filter((e) => e.triageStatus === "failed" && e.processedAt !== null && e.processedAt >= since)
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))),
```

`src/store/firestore.ts`: in `emails: Store["emails"] = { ... }`, add after `listImportantSince`:

```ts
    listFailedSince: async (since) =>
      (await this.all<EmailRecord>(this.col("emails").where("processedAt", ">=", since)))
        .filter((e) => e.triageStatus === "failed")
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
```

- [x] **Step 4: Run the tests**

Run: `npx vitest run test/store/memory.test.ts && npm run typecheck`
Expected: `11 passed`, and typecheck exits 0. If the Firestore emulator is running, `npm run test:firestore` also gives 11 passed.

- [x] **Step 5: Commit**

```bash
git add src/types.ts src/store/types.ts src/store/memory.ts src/store/firestore.ts test/store/contract.ts
git commit -m "feat(contract): heldAlerts state doc and emails.listFailedSince"
```

---

### Task 2: WhatsApp formatting helpers

**Files:**
- Create: `src/brief/format.ts`
- Create: `test/brief/fixtures.ts`
- Test: `test/brief/format.test.ts`

**Interfaces:**
- Consumes: `formatSgt`, `sgtAt`, `sgtDateKey`, `sgtTimeHHMM`, `addDaysToKey` (`src/lib/clock.ts`), plus `Item`, `EmailRecord` and `CalendarEvent`.
- Produces (all pure):
  - `MAX_TITLE = 60`, `MAX_SOURCE = 24`
  - `bold(s: string): string`, `italic(s: string): string`
  - `truncate(s: string, max: number): string`. Collapses whitespace, counts code points, and ends with `…` when cut.
  - `senderName(from: string): string`. `"Mr Lim <lim@x>"` → `"Mr Lim"`, `"lim@x"` → `"lim"`.
  - `sourceLabel(item: Item): string | null`. The sender display name, or the Classroom course name, or null for manual items.
  - `dueDayKey(dueAtIso: string): string`. The SGT day key, where midnight counts as the previous day.
  - `dueTime(dueAtIso: string): string`. `"3pm"`, `"3:30pm"` or `"midnight"`.
  - `shortDay(dateKey: string, todayKey: string): string`. `"Mon"` within ±6 days, otherwise `"4 Oct"`.
  - `isPastDue(item: Pick<Item, "dueAt">, now: Date): boolean`. True when `dueAt <= now`.
  - `whenLabel(dueAtIso: string, now: Date): string`. `"was due Mon"`, `"was due 6am"`, `"due today 3pm"`, `"due tomorrow by midnight"`, `"due Fri 3pm"`, `"due 30 Oct 3pm"`.
  - `type LineMode = "due" | "relative"`
  - `itemText(item, now, mode)`, `itemLine(n, item, now, mode)` → `"2. Title · by 3pm · Mr Lim"`, `itemBullet(item, now, mode = "due")` → `"• Title · by 3pm · Mr Lim"`
  - `eventLine(e: CalendarEvent): string`, `emailLine(e: EmailRecord): string`, `failedEmailsBlock(emails: EmailRecord[]): string | null`, `moreLine(hidden: number): string`, `weekdayOf(now: Date): string`
- Test fixtures produced (`test/brief/fixtures.ts`): `MORNING`, `EVENING`, `emailSource(from)`, `classroomSource(courseName)`, `MANUAL`, `item(id, over)`, `email(id, over)`, `event(id, over)`.

- [x] **Step 1: Write the shared fixtures**

`test/brief/fixtures.ts`:
```ts
import type { CalendarEvent, EmailRecord, Item, ItemSource } from "../../src/types.js";
import { makeItem } from "../store/contract.js";

/** Wed 14 Oct 2026, 06:30 SGT. */
export const MORNING = new Date("2026-10-13T22:30:00.000Z");
/** Wed 14 Oct 2026, 21:00 SGT. */
export const EVENING = new Date("2026-10-14T13:00:00.000Z");

export const emailSource = (from: string): ItemSource =>
  ({ kind: "email", account: "school", emailId: `m-${from.length}`, threadId: `t-${from.length}`, from });

export const classroomSource = (courseName: string): ItemSource =>
  ({ kind: "classroom", courseId: "c1", courseName, courseWorkId: "cw1", announcementId: null, link: null });

export const MANUAL: ItemSource = { kind: "manual" };

export function item(id: string, over: Partial<Omit<Item, "id">> = {}): Item {
  return { ...makeItem({ dedupeKey: `key:${id}`, ...over }), id };
}

export function email(id: string, over: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id, account: "school", threadId: `t-${id}`, from: "Mrs Tan <tan@school.edu.sg>", subject: "Test moved",
    receivedAt: "2026-10-13T12:00:00.000Z", summary: "Thursday's test moved to Friday", category: "teacher_message",
    importance: "high", needsReply: false, triageStatus: "done", triageAttempts: 1,
    processedAt: "2026-10-13T12:00:05.000Z",
    ...over,
  };
}

export function event(id: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, account: "school", calendarId: "primary", title: "Assembly",
    startAt: "2026-10-13T23:30:00.000Z", endAt: "2026-10-14T00:00:00.000Z", allDay: false, location: null,
    ...over,
  };
}
```

- [x] **Step 2: Write the failing test**

`test/brief/format.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  bold, italic, truncate, senderName, sourceLabel, dueDayKey, dueTime, whenLabel,
  itemLine, itemBullet, eventLine, emailLine, failedEmailsBlock, moreLine, weekdayOf,
} from "../../src/brief/format.js";
import { MORNING, MANUAL, classroomSource, email, emailSource, event, item } from "./fixtures.js";

describe("format helpers", () => {
  it("bold and italic", () => {
    expect(bold("Hi")).toBe("*Hi*");
    expect(italic("Hi")).toBe("_Hi_");
  });

  it("truncate collapses whitespace and adds an ellipsis", () => {
    expect(truncate("  Submit\n the   form ", 60)).toBe("Submit the form");
    const long = truncate("a".repeat(70), 60);
    expect(long).toHaveLength(60);
    expect(long.endsWith("…")).toBe(true);
    expect(truncate("😀".repeat(5), 3)).toBe("😀😀…");
  });

  it("senderName prefers the display name", () => {
    expect(senderName("Mr Lim <lim@school.edu.sg>")).toBe("Mr Lim");
    expect(senderName("\"Tan, Mary\" <tan@school.edu.sg>")).toBe("Tan, Mary");
    expect(senderName("<lim@school.edu.sg>")).toBe("lim");
    expect(senderName("lim@school.edu.sg")).toBe("lim");
    expect(senderName("")).toBe("");
  });

  it("sourceLabel: sender, course name, or nothing", () => {
    expect(sourceLabel(item("a", { source: emailSource("Mr Lim <lim@school.edu.sg>") }))).toBe("Mr Lim");
    expect(sourceLabel(item("b", { source: classroomSource("S3-03 Additional Mathematics 2026") })))
      .toBe("S3-03 Additional Mathem…");
    expect(sourceLabel(item("c", { source: MANUAL }))).toBeNull();
  });

  it("midnight belongs to the day before", () => {
    expect(dueDayKey("2026-10-14T16:00:00.000Z")).toBe("2026-10-14"); // Thu 00:00 SGT -> Wed
    expect(dueDayKey("2026-10-14T16:01:00.000Z")).toBe("2026-10-15");
    expect(dueTime("2026-10-14T16:00:00.000Z")).toBe("midnight");
    expect(dueTime("2026-10-14T07:00:00.000Z")).toBe("3pm");
    expect(dueTime("2026-10-14T07:30:00.000Z")).toBe("3:30pm");
  });

  it("whenLabel for past due dates", () => {
    expect(whenLabel("2026-10-13T22:00:00.000Z", MORNING)).toBe("was due 6am");
    expect(whenLabel("2026-10-12T15:59:00.000Z", MORNING)).toBe("was due Mon");
    expect(whenLabel("2026-10-04T04:00:00.000Z", MORNING)).toBe("was due 4 Oct");
  });

  it("whenLabel for future due dates", () => {
    expect(whenLabel("2026-10-14T07:00:00.000Z", MORNING)).toBe("due today 3pm");
    expect(whenLabel("2026-10-15T16:00:00.000Z", MORNING)).toBe("due tomorrow by midnight");
    expect(whenLabel("2026-10-16T07:00:00.000Z", MORNING)).toBe("due Fri 3pm");
    expect(whenLabel("2026-10-30T07:00:00.000Z", MORNING)).toBe("due 30 Oct 3pm");
  });

  it("itemLine: due mode shows 'by', relative mode shows the day, overdue shows 'was due'", () => {
    const cca = item("a", { title: "Submit CCA consent form", dueAt: "2026-10-14T07:00:00.000Z", source: MANUAL });
    expect(itemLine(2, cca, MORNING, "due")).toBe("2. Submit CCA consent form · by 3pm");
    expect(itemLine(2, cca, MORNING, "relative")).toBe("2. Submit CCA consent form · due today 3pm");
    const chem = item("b", {
      title: "Chem practical write-up", dueAt: "2026-10-12T15:59:00.000Z", source: emailSource("Mr Lim <lim@school.edu.sg>"),
    });
    expect(itemLine(1, chem, MORNING, "due")).toBe("1. Chem practical write-up (was due Mon) · Mr Lim");
    const undated = item("c", { title: "x".repeat(80), source: MANUAL });
    expect(itemLine(3, undated, MORNING, "due")).toBe(`3. ${"x".repeat(59)}…`);
    expect(itemBullet(cca, MORNING)).toBe("• Submit CCA consent form · by 3pm");
  });

  it("eventLine", () => {
    expect(eventLine(event("e1", { location: "Hall" }))).toBe("• 7:30am–8am Assembly · Hall");
    expect(eventLine(event("e2", {
      title: "Sports Day", allDay: true, startAt: "2026-10-13T16:00:00.000Z", endAt: "2026-10-14T16:00:00.000Z",
    }))).toBe("• All day: Sports Day");
  });

  it("emailLine and failedEmailsBlock", () => {
    expect(emailLine(email("e1"))).toBe("• Mrs Tan: Thursday's test moved to Friday");
    expect(emailLine(email("e2", { summary: null, subject: "Card statement", from: "alerts@dbs.com" })))
      .toBe("• alerts: Card statement");
    expect(failedEmailsBlock([])).toBeNull();
    expect(failedEmailsBlock([email("f1", { subject: "Fwd: Scan_0012.pdf" })]))
      .toBe("⚠️ 1 email couldn't be read automatically: *Fwd: Scan_0012.pdf*");
    expect(failedEmailsBlock([email("f1", { subject: "A" }), email("f2", { subject: "" })]))
      .toBe("⚠️ 2 emails couldn't be read automatically:\n• *A*\n• *(no subject)*");
  });

  it("moreLine and weekdayOf", () => {
    expect(moreLine(32)).toBe("_…and 32 more. Ask me to list them._");
    expect(weekdayOf(MORNING)).toBe("Wed");
  });
});
```

- [x] **Step 3: Run the test to confirm it fails**

Run: `npx vitest run test/brief/format.test.ts`
Expected: FAIL, because `../../src/brief/format.js` can't be resolved.

- [x] **Step 4: Implement**

`src/brief/format.ts`:
```ts
import type { CalendarEvent, EmailRecord, Item } from "../types.js";
import { addDaysToKey, formatSgt, sgtAt, sgtDateKey, sgtTimeHHMM } from "../lib/clock.js";

export const MAX_TITLE = 60;
export const MAX_SOURCE = 24;
const MAX_FAILED_LISTED = 5;
const DAY_MS = 86_400_000;

export const bold = (s: string): string => `*${s}*`;
export const italic = (s: string): string => `_${s}_`;

/** Collapses whitespace; cuts to `max` code points, ending in "…" when cut. */
export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  const cps = Array.from(t);
  if (cps.length <= max) return t;
  return `${cps.slice(0, max - 1).join("").trimEnd()}…`;
}

/** "Mr Lim <lim@x>" -> "Mr Lim"; "\"Tan, Mary\" <t@x>" -> "Tan, Mary"; "lim@x" -> "lim". */
export function senderName(from: string): string {
  const s = from.trim();
  const lt = s.indexOf("<");
  if (lt > 0) {
    const name = s.slice(0, lt).trim().replace(/^"(.*)"$/, "$1").trim();
    if (name) return name;
  }
  const address = s.match(/<([^>]+)>/)?.[1] ?? s;
  const at = address.indexOf("@");
  return at > 0 ? address.slice(0, at) : address;
}

export function sourceLabel(item: Item): string | null {
  const src = item.source;
  const label = src.kind === "email" ? senderName(src.from) : src.kind === "classroom" ? src.courseName : "";
  return label ? truncate(label, MAX_SOURCE) : null;
}

/** SGT day an item is due on. Exactly 00:00 counts as the end of the previous day. */
export function dueDayKey(dueAtIso: string): string {
  return sgtDateKey(new Date(Date.parse(dueAtIso) - 1));
}

export function dueTime(dueAtIso: string): string {
  const d = new Date(dueAtIso);
  return sgtTimeHHMM(d) === "00:00" ? "midnight" : formatSgt(d, "time");
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
}

/** "Mon" within 6 days of today, otherwise "4 Oct". */
export function shortDay(dateKey: string, todayKey: string): string {
  const [weekday = "", day = "", month = ""] = formatSgt(sgtAt(dateKey, "12:00"), "dayDate").split(" ");
  return Math.abs(dayDiff(dateKey, todayKey)) <= 6 ? weekday : `${day} ${month}`;
}

export function isPastDue(item: Pick<Item, "dueAt">, now: Date): boolean {
  return item.dueAt !== null && Date.parse(item.dueAt) <= now.getTime();
}

export function whenLabel(dueAtIso: string, now: Date): string {
  const today = sgtDateKey(now);
  const key = dueDayKey(dueAtIso);
  const time = dueTime(dueAtIso);
  if (Date.parse(dueAtIso) <= now.getTime()) return `was due ${key === today ? time : shortDay(key, today)}`;
  const day = key === today ? "today" : key === addDaysToKey(today, 1) ? "tomorrow" : shortDay(key, today);
  return `due ${day} ${time === "midnight" ? "by midnight" : time}`;
}

/** "due": the section already says which day, so show "by 3pm". "relative": show the day too. */
export type LineMode = "due" | "relative";

export function itemText(item: Item, now: Date, mode: LineMode): string {
  let text = truncate(item.title, MAX_TITLE);
  if (item.dueAt) {
    if (isPastDue(item, now)) text += ` (${whenLabel(item.dueAt, now)})`;
    else if (mode === "due") text += ` · by ${dueTime(item.dueAt)}`;
    else text += ` · ${whenLabel(item.dueAt, now)}`;
  }
  const src = sourceLabel(item);
  return src ? `${text} · ${src}` : text;
}

export const itemLine = (n: number, item: Item, now: Date, mode: LineMode): string =>
  `${n}. ${itemText(item, now, mode)}`;

export const itemBullet = (item: Item, now: Date, mode: LineMode = "due"): string =>
  `• ${itemText(item, now, mode)}`;

export function eventLine(e: CalendarEvent): string {
  const when = e.allDay
    ? "All day:"
    : `${formatSgt(new Date(e.startAt), "time")}–${formatSgt(new Date(e.endAt), "time")}`;
  const where = e.location ? ` · ${truncate(e.location, 30)}` : "";
  return `• ${when} ${truncate(e.title, MAX_TITLE)}${where}`;
}

export function emailLine(e: EmailRecord): string {
  const who = truncate(senderName(e.from), MAX_SOURCE) || "Unknown sender";
  return `• ${who}: ${truncate(e.summary ?? e.subject, 100)}`;
}

export function moreLine(hidden: number): string {
  return italic(`…and ${hidden} more. Ask me to list them.`);
}

export function failedEmailsBlock(emails: EmailRecord[]): string | null {
  const subject = (e: EmailRecord) => bold(truncate(e.subject || "(no subject)", 80));
  const [first] = emails;
  if (!first) return null;
  if (emails.length === 1) return `⚠️ 1 email couldn't be read automatically: ${subject(first)}`;
  const lines = emails.slice(0, MAX_FAILED_LISTED).map((e) => `• ${subject(e)}`);
  if (emails.length > MAX_FAILED_LISTED) lines.push(moreLine(emails.length - MAX_FAILED_LISTED));
  return [`⚠️ ${emails.length} emails couldn't be read automatically:`, ...lines].join("\n");
}

export function weekdayOf(now: Date): string {
  return formatSgt(now, "dayDate").split(" ")[0] ?? "";
}
```

- [x] **Step 5: Run the tests**

Run: `npx vitest run test/brief/format.test.ts && npm run typecheck`
Expected: `12 passed`, and typecheck exits 0.

- [x] **Step 6: Commit**

```bash
git add src/brief/format.ts test/brief/fixtures.ts test/brief/format.test.ts
git commit -m "feat(brief): WhatsApp formatting helpers"
```

---

### Task 3: Brief builder and the morning brief

**Files:**
- Create: `src/brief/builder.ts`, `src/brief/morning.ts`
- Test: `test/brief/morning.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers, plus `sortItems` (`src/store/filter.ts`) and `sgtDateKey`, `addDaysToKey`, `formatSgt`.
- Produces:
  ```ts
  interface BriefInput {
    openItems: Item[];          // status "open"
    events: CalendarEvent[];    // today's (morning) or tomorrow's (evening)
    importantEmails: EmailRecord[];
    failedEmails: EmailRecord[];
    overnightAlerts: Item[];    // held during quiet hours, still open and un-alerted
    health: string[];           // ready-made "⚠️ ..." lines
    sinceIso: string;           // start of the "new since" window (UTC ISO)
  }
  interface ComposedBrief {
    text: string;
    numbering: Record<string, string>; // "1" -> itemId
    template: TemplateRef;             // brief_ready [label, dueToday, urgent]
    counts: { dueToday: number; urgent: number };
  }
  MAX_ITEMS_PER_SECTION = 8; MAX_BULLETS_PER_SECTION = 8; FOOTER: string
  class BriefBuilder { constructor(now: Date); numbering; items(heading, items, mode): number;
    bullets(heading, lines): void; block(text: string | null): void; urgentCount: number;
    finish(header, emptyLine, health): string }
  uniqueById(items: Item[]): Item[]
  briefTemplate(label: string, dueToday: number, urgent: number): TemplateRef
  composeMorning(input: BriefInput, now: Date): ComposedBrief
  EMPTY_MORNING: string
  ```

Morning layout (§8.2, §7a): header, then *🗓 Today* (events), *⚠️ Overdue*, *📌 Due today*, *🗓 Due tomorrow*, *🌙 Came in overnight* (held alerts), *📬 New & important*, the couldn't-read emails, the health lines and the footer. Held items appear only under *Came in overnight*, never twice. The footer appears only when something is numbered. `counts.dueToday` counts every open item due later today, including held ones and ones hidden by the cap. `counts.urgent` counts every item the brief covers with `urgency === "urgent"`.

- [x] **Step 1: Write the failing test**

`test/brief/morning.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { composeMorning, EMPTY_MORNING } from "../../src/brief/morning.js";
import { FOOTER, type BriefInput } from "../../src/brief/builder.js";
import { MORNING, MANUAL, classroomSource, email, emailSource, event, item } from "./fixtures.js";

const emptyInput = (): BriefInput => ({
  openItems: [], events: [], importantEmails: [], failedEmails: [], overnightAlerts: [], health: [],
  sinceIso: "2026-10-12T22:30:00.000Z",
});

describe("composeMorning", () => {
  it("lays out every section in order with continuous numbering", () => {
    const ong = item("ong", {
      title: "Reply to Mr Ong about CCA camp", urgency: "urgent", source: emailSource("Mr Ong <ong@school.edu.sg>"),
    });
    const input: BriefInput = {
      openItems: [
        item("english", { title: "English essay draft", dueAt: "2026-10-15T09:00:00.000Z",
          source: emailSource("\"Mrs Tan\" <tan@school.edu.sg>") }),
        item("chem", { title: "Chem practical write-up", dueAt: "2026-10-12T15:59:00.000Z",
          source: emailSource("Mr Lim <lim@school.edu.sg>") }),
        item("math", { title: "Math worksheet 4B", dueAt: "2026-10-14T16:00:00.000Z", source: classroomSource("Math 3A") }),
        item("cca", { title: "Submit CCA consent form", dueAt: "2026-10-14T07:00:00.000Z", urgency: "urgent", source: MANUAL }),
        item("read", { title: "Read chapter 5", source: MANUAL }),
        item("later", { title: "Project proposal", dueAt: "2026-10-22T07:00:00.000Z" }),
        ong,
      ],
      events: [
        event("sports", { title: "Sports Day", allDay: true, startAt: "2026-10-13T16:00:00.000Z", endAt: "2026-10-14T16:00:00.000Z" }),
        event("assembly", { location: "Hall" }),
      ],
      importantEmails: [email("e1"), email("e2", { from: "DBS <alerts@dbs.com>", summary: "Card statement ready" })],
      failedEmails: [email("f1", { subject: "Fwd: Scan_0012.pdf", triageStatus: "failed", summary: null })],
      overnightAlerts: [ong],
      health: ['⚠️ School inbox not synced since 2:05pm. Reply "status" for details.'],
      sinceIso: "2026-10-12T22:30:00.000Z",
    };

    const out = composeMorning(input, MORNING);

    expect(out.text).toBe([
      "*Good morning! Wed 14 Oct* ☀️",
      "",
      "*🗓 Today*",
      "• All day: Sports Day",
      "• 7:30am–8am Assembly · Hall",
      "",
      "*⚠️ Overdue*",
      "1. Chem practical write-up (was due Mon) · Mr Lim",
      "",
      "*📌 Due today*",
      "2. Submit CCA consent form · by 3pm",
      "3. Math worksheet 4B · by midnight · Math 3A",
      "",
      "*🗓 Due tomorrow*",
      "4. English essay draft · by 5pm · Mrs Tan",
      "",
      "*🌙 Came in overnight*",
      "5. Reply to Mr Ong about CCA camp · Mr Ong",
      "",
      "*📬 New & important*",
      "• Mrs Tan: Thursday's test moved to Friday",
      "• DBS: Card statement ready",
      "",
      "⚠️ 1 email couldn't be read automatically: *Fwd: Scan_0012.pdf*",
      "",
      '⚠️ School inbox not synced since 2:05pm. Reply "status" for details.',
      "",
      FOOTER,
    ].join("\n"));
    expect(out.numbering).toEqual({ "1": "chem", "2": "cca", "3": "math", "4": "english", "5": "ong" });
    expect(out.counts).toEqual({ dueToday: 2, urgent: 2 });
    expect(out.template).toEqual({ name: "brief_ready", params: ["Wed", "2", "2"] });
  });

  it("a fully empty day gets a friendly one-liner and no footer", () => {
    const out = composeMorning(emptyInput(), MORNING);
    expect(out.text).toBe(`*Good morning! Wed 14 Oct* ☀️\n\n${EMPTY_MORNING}`);
    expect(out.numbering).toEqual({});
    expect(out.template).toEqual({ name: "brief_ready", params: ["Wed", "0", "0"] });
  });

  it("an empty day still shows health lines", () => {
    const health = ['⚠️ Personal inbox not synced since 3am. Reply "status" for details.'];
    const out = composeMorning({ ...emptyInput(), health }, MORNING);
    expect(out.text).toBe(`*Good morning! Wed 14 Oct* ☀️\n\n${EMPTY_MORNING}\n\n${health[0]}`);
  });

  it("40 open items: sections are capped, counts stay true, text stays short", () => {
    const overdue = Array.from({ length: 40 }, (_, k) =>
      item(`o${k}`, { title: `Overdue thing number ${k} with a fairly long descriptive title`, dueAt: "2026-10-12T15:59:00.000Z" }));
    const today = Array.from({ length: 40 }, (_, k) =>
      item(`t${k}`, { title: `Due today ${k}`, dueAt: "2026-10-14T07:00:00.000Z" }));
    const out = composeMorning({ ...emptyInput(), openItems: [...overdue, ...today] }, MORNING);
    expect(Object.keys(out.numbering)).toHaveLength(16);
    expect(out.numbering["9"]).toBe("t0");
    expect(out.text.split("_…and 32 more. Ask me to list them._")).toHaveLength(3); // once per section
    expect(out.text).not.toContain("17. ");
    expect(out.text.length).toBeLessThan(4096);
    expect(out.counts.dueToday).toBe(40);
    expect(out.template.params).toEqual(["Wed", "40", "0"]);
  });

  it("a held overnight alert is listed once, under 'Came in overnight'", () => {
    const held = item("held", { title: "Bring lab coat", dueAt: "2026-10-14T07:00:00.000Z", urgency: "urgent", source: MANUAL });
    const out = composeMorning({ ...emptyInput(), openItems: [held], overnightAlerts: [held] }, MORNING);
    expect(out.text).toBe(`*Good morning! Wed 14 Oct* ☀️\n\n*🌙 Came in overnight*\n1. Bring lab coat · due today 3pm\n\n${FOOTER}`);
    expect(out.counts).toEqual({ dueToday: 1, urgent: 1 });
  });

  it("an item due exactly at midnight counts as due the day before", () => {
    const math = item("math", { title: "Math worksheet 4B", dueAt: "2026-10-14T16:00:00.000Z", source: MANUAL });
    const out = composeMorning({ ...emptyInput(), openItems: [math] }, MORNING);
    expect(out.text).toContain("*📌 Due today*\n1. Math worksheet 4B · by midnight");
    expect(out.text).not.toContain("Due tomorrow");
    expect(out.counts.dueToday).toBe(1);
  });
});
```

- [x] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run test/brief/morning.test.ts`
Expected: FAIL, because `../../src/brief/morning.js` can't be resolved.

- [x] **Step 3: Implement the builder**

`src/brief/builder.ts`:
```ts
import type { CalendarEvent, EmailRecord, Item, TemplateRef } from "../types.js";
import { bold, itemLine, moreLine, type LineMode } from "./format.js";

export interface BriefInput {
  openItems: Item[];
  events: CalendarEvent[];
  importantEmails: EmailRecord[];
  failedEmails: EmailRecord[];
  overnightAlerts: Item[];
  health: string[];
  /** Start of the "new since" window, UTC ISO: the last morning brief's scheduled time. */
  sinceIso: string;
}

export interface ComposedBrief {
  text: string;
  numbering: Record<string, string>;
  template: TemplateRef;
  counts: { dueToday: number; urgent: number };
}

export const MAX_ITEMS_PER_SECTION = 8;
export const MAX_BULLETS_PER_SECTION = 8;
export const FOOTER = `_Reply "done 2", "snooze 3 to tomorrow", or ask me anything._`;

export function uniqueById(items: Item[]): Item[] {
  const seen = new Map<string, Item>();
  for (const i of items) if (!seen.has(i.id)) seen.set(i.id, i);
  return [...seen.values()];
}

export function briefTemplate(label: string, dueToday: number, urgent: number): TemplateRef {
  return { name: "brief_ready", params: [label, String(dueToday), String(urgent)] };
}

/** Collects sections, numbers items continuously, and never lists an item twice. */
export class BriefBuilder {
  readonly numbering: Record<string, string> = {};
  private readonly blocks: string[] = [];
  private readonly listed = new Map<string, Item>();
  private n = 0;

  constructor(private readonly now: Date) {}

  /**
   * Numbered section. Items already listed earlier are skipped. At most MAX_ITEMS_PER_SECTION
   * lines are shown, then a "…and N more" line. Returns how many items the section covers
   * (including hidden ones). Empty sections are omitted.
   */
  items(heading: string, items: Item[], mode: LineMode): number {
    const fresh = items.filter((i) => !this.listed.has(i.id));
    if (fresh.length === 0) return 0;
    for (const i of fresh) this.listed.set(i.id, i);
    const lines = fresh.slice(0, MAX_ITEMS_PER_SECTION).map((i) => {
      this.n += 1;
      this.numbering[String(this.n)] = i.id;
      return itemLine(this.n, i, this.now, mode);
    });
    if (fresh.length > MAX_ITEMS_PER_SECTION) lines.push(moreLine(fresh.length - MAX_ITEMS_PER_SECTION));
    this.blocks.push([bold(heading), ...lines].join("\n"));
    return fresh.length;
  }

  /** Bulleted section (events, emails). Omitted when empty. */
  bullets(heading: string, lines: string[]): void {
    if (lines.length === 0) return;
    const shown = lines.slice(0, MAX_BULLETS_PER_SECTION);
    if (lines.length > shown.length) shown.push(moreLine(lines.length - shown.length));
    this.blocks.push([bold(heading), ...shown].join("\n"));
  }

  /** Free-form block without a heading. Ignored when null. */
  block(text: string | null): void {
    if (text) this.blocks.push(text);
  }

  get urgentCount(): number {
    return [...this.listed.values()].filter((i) => i.urgency === "urgent").length;
  }

  finish(header: string, emptyLine: string, health: string[]): string {
    const parts = [header, ...(this.blocks.length === 0 ? [emptyLine] : this.blocks)];
    if (health.length > 0) parts.push(health.join("\n"));
    if (this.n > 0) parts.push(FOOTER);
    return parts.join("\n\n");
  }
}
```

- [x] **Step 4: Implement the morning composer**

`src/brief/morning.ts`:
```ts
import { addDaysToKey, formatSgt, sgtDateKey } from "../lib/clock.js";
import { sortItems } from "../store/filter.js";
import type { Item } from "../types.js";
import { BriefBuilder, briefTemplate, uniqueById, type BriefInput, type ComposedBrief } from "./builder.js";
import { dueDayKey, emailLine, eventLine, failedEmailsBlock, isPastDue, weekdayOf } from "./format.js";

export const EMPTY_MORNING = "Nothing due today and nothing new. Enjoy your day! 🎉";

export function composeMorning(input: BriefInput, now: Date): ComposedBrief {
  const today = sgtDateKey(now);
  const tomorrow = addDaysToKey(today, 1);
  const held = new Set(input.overnightAlerts.map((i) => i.id));
  const onDay = (key: string) => (i: Item) =>
    i.dueAt !== null && !isPastDue(i, now) && dueDayKey(i.dueAt) === key;
  const dated = sortItems(input.openItems.filter((i) => i.dueAt !== null && !held.has(i.id)));

  const b = new BriefBuilder(now);
  b.bullets("🗓 Today", input.events.map(eventLine));
  b.items("⚠️ Overdue", dated.filter((i) => isPastDue(i, now)), "due");
  b.items("📌 Due today", dated.filter(onDay(today)), "due");
  b.items("🗓 Due tomorrow", dated.filter(onDay(tomorrow)), "due");
  b.items("🌙 Came in overnight", sortItems(input.overnightAlerts), "relative");
  b.bullets("📬 New & important", input.importantEmails.map(emailLine));
  b.block(failedEmailsBlock(input.failedEmails));

  const text = b.finish(`*Good morning! ${formatSgt(now, "dayDate")}* ☀️`, EMPTY_MORNING, input.health);
  const dueToday = uniqueById([...input.openItems, ...input.overnightAlerts]).filter(onDay(today)).length;
  const urgent = b.urgentCount;
  return {
    text,
    numbering: b.numbering,
    template: briefTemplate(weekdayOf(now), dueToday, urgent),
    counts: { dueToday, urgent },
  };
}
```

- [x] **Step 5: Run the tests**

Run: `npx vitest run test/brief && npm run typecheck`
Expected: `18 passed` (12 format + 6 morning), and typecheck exits 0.

- [x] **Step 6: Commit**

```bash
git add src/brief/builder.ts src/brief/morning.ts test/brief/morning.test.ts
git commit -m "feat(brief): morning brief composer with numbering and section caps"
```

---

### Task 4: Evening check-in

**Files:**
- Create: `src/brief/evening.ts`
- Test: `test/brief/evening.test.ts`

**Interfaces:**
- Consumes: `BriefBuilder`, `briefTemplate`, `uniqueById`, `BriefInput` and `ComposedBrief` (Task 3), plus the Task 2 helpers.
- Produces: `composeEvening(input: BriefInput, now: Date): ComposedBrief` and `EMPTY_EVENING: string`.

Evening layout (§8.2, §7a): header, *🗓 Tomorrow* (events), *🗓 Due tomorrow*, *⏳ Still open from today* (items due today that are still open, including ones already past), *🚨 Urgent since this morning*, health lines and the footer. The urgent section contains held overnight alerts, plus open items that were alerted at or after `sinceIso`, plus open items with `urgency === "urgent"` created at or after `sinceIso`, minus anything already listed. `importantEmails` and `failedEmails` are ignored, because they belong to the morning. The template label is `"<Weekday> evening"`. `counts.dueToday` is the number of items still open from today.

- [ ] **Step 1: Write the failing test**

`test/brief/evening.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { composeEvening, EMPTY_EVENING } from "../../src/brief/evening.js";
import { FOOTER, type BriefInput } from "../../src/brief/builder.js";
import { EVENING, MANUAL, classroomSource, email, emailSource, event, item } from "./fixtures.js";

const emptyInput = (): BriefInput => ({
  openItems: [], events: [], importantEmails: [], failedEmails: [], overnightAlerts: [], health: [],
  sinceIso: "2026-10-13T22:30:00.000Z", // Wed 06:30 SGT
});

describe("composeEvening", () => {
  it("lays out tomorrow, still-open and urgent-since-morning sections", () => {
    const input: BriefInput = {
      ...emptyInput(),
      openItems: [
        item("english", { title: "English essay draft", dueAt: "2026-10-15T09:00:00.000Z",
          source: emailSource("\"Mrs Tan\" <tan@school.edu.sg>") }),
        item("cca", { title: "Submit CCA consent form", dueAt: "2026-10-14T07:00:00.000Z", urgency: "urgent", source: MANUAL }),
        item("math", { title: "Math worksheet 4B", dueAt: "2026-10-14T16:00:00.000Z", source: classroomSource("Math 3A") }),
        item("chem", { title: "Chem practical write-up", dueAt: "2026-10-12T15:59:00.000Z",
          source: emailSource("Mr Lim <lim@school.edu.sg>") }),
        item("reply", { title: "Reply to Mrs Tan about project groups", urgency: "urgent",
          createdAt: "2026-10-14T06:00:00.000Z", source: emailSource("Mrs Tan <tan@school.edu.sg>") }),
        item("old", { title: "Old urgent thing", urgency: "urgent", createdAt: "2026-10-10T01:00:00.000Z", source: MANUAL }),
      ],
      events: [event("chem-test", { title: "Chem test", startAt: "2026-10-15T02:00:00.000Z", endAt: "2026-10-15T03:00:00.000Z" })],
      importantEmails: [email("e1")],
    };

    const out = composeEvening(input, EVENING);

    expect(out.text).toBe([
      "*Evening check-in · Wed 14 Oct* 🌙",
      "",
      "*🗓 Tomorrow*",
      "• 10am–11am Chem test",
      "",
      "*🗓 Due tomorrow*",
      "1. English essay draft · by 5pm · Mrs Tan",
      "",
      "*⏳ Still open from today*",
      "2. Submit CCA consent form (was due 3pm)",
      "3. Math worksheet 4B · by midnight · Math 3A",
      "",
      "*🚨 Urgent since this morning*",
      "4. Reply to Mrs Tan about project groups · Mrs Tan",
      "",
      FOOTER,
    ].join("\n"));
    expect(out.numbering).toEqual({ "1": "english", "2": "cca", "3": "math", "4": "reply" });
    expect(out.counts).toEqual({ dueToday: 2, urgent: 2 });
    expect(out.template).toEqual({ name: "brief_ready", params: ["Wed evening", "2", "2"] });
  });

  it("a fully empty evening gets a friendly one-liner", () => {
    const out = composeEvening(emptyInput(), EVENING);
    expect(out.text).toBe(`*Evening check-in · Wed 14 Oct* 🌙\n\n${EMPTY_EVENING}`);
    expect(out.template).toEqual({ name: "brief_ready", params: ["Wed evening", "0", "0"] });
  });

  it("urgent-since includes alerted-since and held alerts, not old urgent items", () => {
    const vip = item("vip", { title: "Mr Lee wants a reply", alertedAt: "2026-10-14T03:00:00.000Z",
      createdAt: "2026-10-13T01:00:00.000Z", source: emailSource("Mr Lee <lee@school.edu.sg>") });
    const old = item("old", { title: "Old urgent thing", urgency: "urgent", createdAt: "2026-10-10T01:00:00.000Z", source: MANUAL });
    const held = item("held", { title: "Camp form", urgency: "urgent", createdAt: "2026-10-13T16:00:00.000Z", source: MANUAL });
    const out = composeEvening({ ...emptyInput(), openItems: [vip, old, held], overnightAlerts: [held] }, EVENING);
    expect(out.text).toBe([
      "*Evening check-in · Wed 14 Oct* 🌙",
      "",
      "*🚨 Urgent since this morning*",
      "1. Mr Lee wants a reply · Mr Lee",
      "2. Camp form",
      "",
      FOOTER,
    ].join("\n"));
    expect(out.counts).toEqual({ dueToday: 0, urgent: 1 });
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run test/brief/evening.test.ts`
Expected: FAIL, because `../../src/brief/evening.js` can't be resolved.

- [ ] **Step 3: Implement**

`src/brief/evening.ts`:
```ts
import { addDaysToKey, formatSgt, sgtDateKey } from "../lib/clock.js";
import { sortItems } from "../store/filter.js";
import type { Item } from "../types.js";
import { BriefBuilder, briefTemplate, uniqueById, type BriefInput, type ComposedBrief } from "./builder.js";
import { dueDayKey, eventLine, weekdayOf } from "./format.js";

export const EMPTY_EVENING = "Nothing due tomorrow and nothing left open. Sleep well! 😴";

export function composeEvening(input: BriefInput, now: Date): ComposedBrief {
  const today = sgtDateKey(now);
  const tomorrow = addDaysToKey(today, 1);
  const since = input.sinceIso;
  const dayOf = (i: Item) => (i.dueAt ? dueDayKey(i.dueAt) : null);
  const dated = sortItems(input.openItems.filter((i) => i.dueAt !== null));
  const urgentSince = input.openItems.filter((i) =>
    (i.alertedAt !== null && i.alertedAt >= since) || (i.urgency === "urgent" && i.createdAt >= since));

  const b = new BriefBuilder(now);
  b.bullets("🗓 Tomorrow", input.events.map(eventLine));
  b.items("🗓 Due tomorrow", dated.filter((i) => dayOf(i) === tomorrow), "due");
  const stillOpen = b.items("⏳ Still open from today", dated.filter((i) => dayOf(i) === today), "due");
  b.items("🚨 Urgent since this morning", sortItems(uniqueById([...input.overnightAlerts, ...urgentSince])), "relative");

  const text = b.finish(`*Evening check-in · ${formatSgt(now, "dayDate")}* 🌙`, EMPTY_EVENING, input.health);
  const urgent = b.urgentCount;
  return {
    text,
    numbering: b.numbering,
    template: briefTemplate(`${weekdayOf(now)} evening`, stillOpen, urgent),
    counts: { dueToday: stillOpen, urgent },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/brief && npm run typecheck`
Expected: `21 passed`, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/brief/evening.ts test/brief/evening.test.ts
git commit -m "feat(brief): evening check-in composer"
```

---

### Task 5: Held alerts and the Notifier

**Files:**
- Create: `src/notify/held.ts`, `src/notify/notifier.ts`, `test/helpers/scheduler-fakes.ts`
- Test: `test/notify/notifier.test.ts`

**Interfaces:**
- Consumes: `Deps`, `Notifier`, `Outbox`, `OutboundMessage` (ports), `isQuietTime`, `sortItems`, `itemLine`, `truncate`, `moreLine` and `MAX_ITEMS_PER_SECTION`.
- Produces:
  - `src/notify/held.ts`: `heldAlertIds(store: Store): Promise<string[]>`, `addHeldAlerts(store, ids: string[]): Promise<void>`, `loadHeldAlerts(store): Promise<Item[]>` (only items that are open and have `alertedAt === null`), `markAlerted(store, ids: string[], nowIso: string): Promise<void>` (sets `alertedAt` and removes the IDs from the held list), and `pruneHeldAlerts(store): Promise<void>` (drops IDs whose items aren't open and un-alerted any more).
  - `src/notify/notifier.ts`: `createNotifier(deps: Pick<Deps, "clock" | "log" | "store" | "outbox">): Notifier`, `composeAlert(items: Item[], now: Date): ComposedAlert` and `ALERT_SUMMARY_MAX = 60`.
  - `test/helpers/scheduler-fakes.ts`: `recordingOutbox()`, `fakeMail(over?)`, `fakeCalendar(events?)`, `fakeClassroom(over?)`, `makeSchedulerDeps(nowIso, over?)`.

`sendAlerts(items)` works like this:
1. An empty list does nothing.
2. Re-read each unique ID from the store, and keep only items that are `open` with `alertedAt === null`.
3. If none are left, stop.
4. During quiet hours, add the IDs to `state/heldAlerts` and send nothing.
5. Otherwise, compose one grouped message (numbered, at most 8 lines), call `outbox.deliver({kind:"alert", text, template: heads_up [summary ≤ 60]})`, save the numbering to `state/lastList`, and set `alertedAt` on every item.
6. If `deliver` throws, add the items to the held list (so the next brief still shows them) and rethrow.

- [ ] **Step 1: Write the test fakes**

`test/helpers/scheduler-fakes.ts`:
```ts
import { EMPTY_SYNC } from "../../src/ports.js";
import type { CalendarService, ClassroomService, Deps, MailService, OutboundMessage, Outbox } from "../../src/ports.js";
import type { CalendarEvent } from "../../src/types.js";
import { createNotifier } from "../../src/notify/notifier.js";
import { makeTestDeps } from "./deps.js";

export type RecordingOutbox = Outbox & { sent: OutboundMessage[]; flushes: number };

/** Outbox that "sends" everything immediately and records it. */
export function recordingOutbox(): RecordingOutbox {
  const o: RecordingOutbox = {
    sent: [],
    flushes: 0,
    async deliver(msg) {
      o.sent.push(msg);
      return "sent";
    },
    async flush() {
      o.flushes += 1;
      return 0;
    },
  };
  return o;
}

/** Mail service whose sync/retry/watch calls succeed with nothing to do. Override per test. */
export function fakeMail(over: Partial<MailService> = {}): MailService {
  const unexpected = (m: string) => async () => {
    throw new Error(`mail.${m} unexpected in scheduler tests`);
  };
  return {
    handlePush: unexpected("handlePush"),
    search: unexpected("search"),
    read: unexpected("read"),
    syncAccount: async () => EMPTY_SYNC,
    retryPendingTriage: async () => EMPTY_SYNC,
    renewWatchIfNeeded: async () => {},
    ...over,
  };
}

export function fakeCalendar(events: CalendarEvent[] = []): CalendarService & { calls: Array<[string, string]> } {
  const cal = {
    calls: [] as Array<[string, string]>,
    async listEvents(fromIso: string, toIso: string) {
      cal.calls.push([fromIso, toIso]);
      return events;
    },
  };
  return cal;
}

export function fakeClassroom(over: Partial<ClassroomService> = {}): ClassroomService {
  return { syncIfDue: async () => EMPTY_SYNC, sync: async () => EMPTY_SYNC, ...over };
}

/** Test deps with working fakes for every service the scheduler touches, the clock at `nowIso`, and a real Notifier. */
export function makeSchedulerDeps(nowIso: string, over: Partial<Deps> = {}) {
  const outbox = recordingOutbox();
  const deps = makeTestDeps({
    mail: fakeMail(), calendar: fakeCalendar(), classroom: fakeClassroom(), outbox, ...over,
  });
  deps.clock.set(nowIso);
  deps.notifier = createNotifier(deps);
  return { deps, outbox };
}
```

- [ ] **Step 2: Write the failing test**

`test/notify/notifier.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createNotifier } from "../../src/notify/notifier.js";
import { heldAlertIds } from "../../src/notify/held.js";
import { makeTestDeps } from "../helpers/deps.js";
import { recordingOutbox } from "../helpers/scheduler-fakes.js";
import { makeItem } from "../store/contract.js";

const WED_0800 = "2026-10-14T00:00:00.000Z";
const WED_2300 = "2026-10-14T15:00:00.000Z"; // quiet hours

function setup(nowIso = WED_0800) {
  const outbox = recordingOutbox();
  const deps = makeTestDeps({ outbox });
  deps.clock.set(nowIso);
  return { deps, outbox, notifier: createNotifier(deps) };
}

describe("Notifier.sendAlerts", () => {
  it("does nothing for an empty list", async () => {
    const deps = makeTestDeps(); // outbox stub throws if touched
    await expect(createNotifier(deps).sendAlerts([])).resolves.toBeUndefined();
  });

  it("groups items into one numbered message, saves lastList and marks them alerted", async () => {
    const { deps, outbox, notifier } = setup();
    const a = await deps.store.items.create(makeItem({
      title: "Submit CCA consent form", dueAt: "2026-10-14T07:00:00.000Z", urgency: "urgent", dedupeKey: "a",
    }));
    const b = await deps.store.items.create(makeItem({ title: "Chem test moved to Friday", dedupeKey: "b" }));
    await notifier.sendAlerts([b, a]);
    expect(outbox.sent).toEqual([{
      kind: "alert",
      text: `⚠️ *Heads up*\n1. Submit CCA consent form · due today 3pm · Mr Tan\n2. Chem test moved to Friday · Mr Tan\n\n_Reply "done 1" when it's sorted._`,
      template: { name: "heads_up", params: ["2 things: Submit CCA consent form; Chem test moved to Friday"] },
    }]);
    expect(await deps.store.state.get("lastList")).toEqual({ at: WED_0800, map: { "1": a.id, "2": b.id } });
    expect((await deps.store.items.get(a.id))?.alertedAt).toBe(WED_0800);
    expect((await deps.store.items.get(b.id))?.alertedAt).toBe(WED_0800);
  });

  it("a single item's summary is its title, cut to 60 characters", async () => {
    const { deps, outbox, notifier } = setup();
    const a = await deps.store.items.create(makeItem({ title: `Urgent ${"x".repeat(80)}`, dedupeKey: "a" }));
    await notifier.sendAlerts([a]);
    const summary = outbox.sent[0]?.template.params[0] ?? "";
    expect(summary).toHaveLength(60);
    expect(summary.startsWith("Urgent xxx")).toBe(true);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("drops items that were closed or already alerted since the sync", async () => {
    const { deps, outbox, notifier } = setup();
    const done = await deps.store.items.create(makeItem({ title: "Done one", dedupeKey: "d" }));
    const alerted = await deps.store.items.create(makeItem({ title: "Alerted one", dedupeKey: "al" }));
    await deps.store.items.update(done.id, { status: "done" });
    await deps.store.items.update(alerted.id, { alertedAt: "2026-10-13T23:00:00.000Z" });
    await notifier.sendAlerts([done, alerted]); // stale snapshots still say open/un-alerted
    expect(outbox.sent).toEqual([]);
  });

  it("holds alerts during quiet hours instead of sending", async () => {
    const { deps, outbox, notifier } = setup(WED_2300);
    const a = await deps.store.items.create(makeItem({ urgency: "urgent", dedupeKey: "a" }));
    await notifier.sendAlerts([a]);
    await notifier.sendAlerts([a]); // a second sync reporting the same item
    expect(outbox.sent).toEqual([]);
    expect((await deps.store.items.get(a.id))?.alertedAt).toBeNull();
    expect(await heldAlertIds(deps.store)).toEqual([a.id]);
  });

  it("on delivery failure, holds the items for the next brief and rethrows", async () => {
    const deps = makeTestDeps({
      outbox: { deliver: async () => { throw new Error("graph 500"); }, flush: async () => 0 },
    });
    const a = await deps.store.items.create(makeItem({ urgency: "urgent", dedupeKey: "a" }));
    await expect(createNotifier(deps).sendAlerts([a])).rejects.toThrow("graph 500");
    expect((await deps.store.items.get(a.id))?.alertedAt).toBeNull();
    expect(await heldAlertIds(deps.store)).toEqual([a.id]);
  });

  it("caps a large batch at 8 lines", async () => {
    const { deps, outbox, notifier } = setup();
    const items = [];
    for (let k = 0; k < 12; k++) {
      items.push(await deps.store.items.create(makeItem({ title: `Thing ${k}`, dedupeKey: `k${k}`,
        createdAt: `2026-10-13T0${Math.floor(k / 10)}:${String(k % 10).padStart(2, "0")}:00.000Z` })));
    }
    await notifier.sendAlerts(items);
    const text = outbox.sent[0]?.text ?? "";
    expect(text).toContain("8. Thing 7");
    expect(text).not.toContain("9. ");
    expect(text).toContain("_…and 4 more. Ask me to list them._");
    expect(Object.keys((await deps.store.state.get("lastList"))?.map ?? {})).toHaveLength(8);
    for (const i of items) expect((await deps.store.items.get(i.id))?.alertedAt).toBe(WED_0800);
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `npx vitest run test/notify/notifier.test.ts`
Expected: FAIL, because `../../src/notify/notifier.js` can't be resolved.

- [ ] **Step 4: Implement the held-alerts helpers**

`src/notify/held.ts`:
```ts
import type { Store } from "../store/types.js";
import type { Item } from "../types.js";

export async function heldAlertIds(store: Store): Promise<string[]> {
  return (await store.state.get("heldAlerts"))?.itemIds ?? [];
}

export async function addHeldAlerts(store: Store, ids: string[]): Promise<void> {
  const current = await heldAlertIds(store);
  await store.state.set("heldAlerts", { itemIds: [...new Set([...current, ...ids])] });
}

/** Held items that still deserve mention: open and never alerted. */
export async function loadHeldAlerts(store: Store): Promise<Item[]> {
  const ids = [...new Set(await heldAlertIds(store))];
  const items = await Promise.all(ids.map((id) => store.items.get(id)));
  return items.filter((i): i is Item => i !== null && i.status === "open" && i.alertedAt === null);
}

/** Sets alertedAt on each item and removes them from the held list. */
export async function markAlerted(store: Store, ids: string[], nowIso: string): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) await store.items.update(id, { alertedAt: nowIso });
  const current = await heldAlertIds(store);
  const remaining = current.filter((id) => !ids.includes(id));
  if (remaining.length !== current.length) await store.state.set("heldAlerts", { itemIds: remaining });
}

/** Drops held IDs whose items were closed, deleted or alerted some other way. */
export async function pruneHeldAlerts(store: Store): Promise<void> {
  const current = await heldAlertIds(store);
  if (current.length === 0) return;
  const keep = (await loadHeldAlerts(store)).map((i) => i.id);
  if (keep.length !== current.length) await store.state.set("heldAlerts", { itemIds: keep });
}
```

- [ ] **Step 5: Implement the Notifier**

`src/notify/notifier.ts`:
```ts
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
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/notify && npm test && npm run typecheck`
Expected: `7 passed` for the notifier, the full suite green, and typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/notify test/notify test/helpers/scheduler-fakes.ts
git commit -m "feat(notify): grouped alerts with quiet-hours hold"
```

---

### Task 6: Gather brief input

**Files:**
- Create: `src/brief/gather.ts`
- Test: `test/brief/gather.test.ts`

**Interfaces:**
- Consumes: `Store` (including `emails.listFailedSince` from Task 1), `CalendarService`, `loadHeldAlerts` (Task 5), `BriefInput` (Task 3), and the clock helpers.
- Produces:
  - `type BriefKind = "morning" | "evening"`
  - `gatherBriefInput(deps: Pick<Deps, "store" | "calendar" | "log">, kind: BriefKind, now: Date): Promise<BriefInput>`
  - `healthLines(store: Store, now: Date): Promise<string[]>`
  - `CALENDAR_DOWN`, `STALE_SYNC_MS = 2h`, `STUCK_OUTBOX_ATTEMPTS = 3`

Rules:
- **Calendar window.** Morning uses today's SGT day `[00:00, 24:00)`. Evening uses tomorrow's.
- **Calendar failures** are caught. `events` becomes `[]` and `CALENDAR_DOWN` is added to `health`. A calendar failure never blocks the brief.
- **`sinceIso`** is the scheduled time of the last morning brief. For a morning brief that's yesterday at `morningAt`, and for an evening brief it's today at `morningAt`. "New & important" and couldn't-read emails cover the 24h since the previous morning brief, because the evening check-in has no email section. With the evening as the start of the window, emails processed between 06:30 and 21:00 would never be listed.
- **Health lines,** in this order:
  - For each account (personal, then school) with a stored doc: `revoked` gives "⚠️ School account disconnected. Run \`npm run auth -- school\` to reconnect.". No `lastSyncAt` gives "⚠️ School inbox hasn't synced yet. …". A `lastSyncAt` more than 2h old gives "⚠️ School inbox not synced since 2:05pm. Reply "status" for details." (if it's from an earlier SGT day, the time becomes "Tue 13 Oct, 2:05pm").
  - Then outbox messages that are pending with `lastError !== null && attempts >= 3`. Pending messages with no error are just waiting for the 24h window, so they're not stuck.
  - Then the calendar failure line.

- [ ] **Step 1: Write the failing test**

`test/brief/gather.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { gatherBriefInput, healthLines, CALENDAR_DOWN } from "../../src/brief/gather.js";
import { addHeldAlerts } from "../../src/notify/held.js";
import { makeTestDeps } from "../helpers/deps.js";
import { fakeCalendar } from "../helpers/scheduler-fakes.js";
import { makeItem } from "../store/contract.js";
import type { AccountState } from "../../src/types.js";
import { MORNING, EVENING, email, event } from "./fixtures.js";

const account = (over: Partial<AccountState> & Pick<AccountState, "id">): AccountState => ({
  email: `${over.id}@example.com`, historyId: "1", watchExpiresAt: null,
  lastSyncAt: "2026-10-13T22:25:00.000Z", authStatus: "ok", ...over,
});

describe("gatherBriefInput", () => {
  it("morning: today's events, open items, emails since yesterday's morning brief", async () => {
    const calendar = fakeCalendar([event("assembly")]);
    const deps = makeTestDeps({ calendar });
    const open = await deps.store.items.create(makeItem({ title: "Open", dedupeKey: "o" }));
    await deps.store.items.create(makeItem({ title: "Done", dedupeKey: "d", status: "done" }));
    await deps.store.items.create(makeItem({ title: "Snoozed", dedupeKey: "s", status: "snoozed",
      snoozedUntil: "2026-10-20T00:00:00.000Z" }));
    await deps.store.emails.upsert(email("new", { processedAt: "2026-10-13T01:00:00.000Z" }));
    await deps.store.emails.upsert(email("old", { processedAt: "2026-10-12T20:00:00.000Z" }));
    await deps.store.emails.upsert(email("bad", { triageStatus: "failed", summary: null, processedAt: "2026-10-13T10:00:00.000Z" }));

    const input = await gatherBriefInput(deps, "morning", MORNING);

    expect(calendar.calls).toEqual([["2026-10-13T16:00:00.000Z", "2026-10-14T16:00:00.000Z"]]);
    expect(input.sinceIso).toBe("2026-10-12T22:30:00.000Z");
    expect(input.openItems.map((i) => i.id)).toEqual([open.id]);
    expect(input.importantEmails.map((e) => e.id)).toEqual(["new"]);
    expect(input.failedEmails.map((e) => e.id)).toEqual(["bad"]);
    expect(input.events.map((e) => e.id)).toEqual(["assembly"]);
    expect(input.overnightAlerts).toEqual([]);
    expect(input.health).toEqual([]);
  });

  it("evening: tomorrow's events, since this morning", async () => {
    const calendar = fakeCalendar();
    const deps = makeTestDeps({ calendar });
    const input = await gatherBriefInput(deps, "evening", EVENING);
    expect(calendar.calls).toEqual([["2026-10-14T16:00:00.000Z", "2026-10-15T16:00:00.000Z"]]);
    expect(input.sinceIso).toBe("2026-10-13T22:30:00.000Z");
  });

  it("a calendar failure gives empty events and a health line, never an error", async () => {
    const deps = makeTestDeps({ calendar: { listEvents: async () => { throw new Error("403 forbidden"); } } });
    const input = await gatherBriefInput(deps, "morning", MORNING);
    expect(input.events).toEqual([]);
    expect(input.health).toEqual([CALENDAR_DOWN]);
  });

  it("overnight alerts are held items that are still open and un-alerted", async () => {
    const deps = makeTestDeps({ calendar: fakeCalendar() });
    const open = await deps.store.items.create(makeItem({ title: "Held", dedupeKey: "h" }));
    const done = await deps.store.items.create(makeItem({ title: "Closed", dedupeKey: "c", status: "done" }));
    const sent = await deps.store.items.create(makeItem({ title: "Sent", dedupeKey: "s", alertedAt: "2026-10-13T23:00:00.000Z" }));
    await addHeldAlerts(deps.store, [open.id, done.id, sent.id]);
    const input = await gatherBriefInput(deps, "morning", MORNING);
    expect(input.overnightAlerts.map((i) => i.id)).toEqual([open.id]);
  });
});

describe("healthLines", () => {
  it("reports a stale inbox, a revoked account and stuck WhatsApp messages", async () => {
    const deps = makeTestDeps();
    await deps.store.accounts.upsert(account({ id: "personal", lastSyncAt: "2026-10-13T19:00:00.000Z" })); // 03:00 SGT
    await deps.store.accounts.upsert(account({ id: "school", authStatus: "revoked" }));
    const msg = { kind: "alert" as const, text: "x", template: null, status: "pending" as const,
      createdAt: "2026-10-13T20:00:00.000Z", sentAt: null };
    await deps.store.outbox.create({ ...msg, attempts: 3, lastError: "131047" });
    await deps.store.outbox.create({ ...msg, attempts: 0, lastError: null }); // just waiting for the window
    expect(await healthLines(deps.store, MORNING)).toEqual([
      '⚠️ Personal inbox not synced since 3am. Reply "status" for details.',
      "⚠️ School account disconnected. Run `npm run auth -- school` to reconnect.",
      '⚠️ 1 WhatsApp message couldn\'t be sent. Reply "status" for details.',
    ]);
  });

  it("is quiet when syncs are fresh; names the day when the last sync was yesterday", async () => {
    const deps = makeTestDeps();
    await deps.store.accounts.upsert(account({ id: "personal" }));
    expect(await healthLines(deps.store, MORNING)).toEqual([]);
    await deps.store.accounts.upsert(account({ id: "school", lastSyncAt: "2026-10-13T06:05:00.000Z" })); // Tue 14:05 SGT
    expect(await healthLines(deps.store, MORNING)).toEqual([
      '⚠️ School inbox not synced since Tue 13 Oct, 2:05pm. Reply "status" for details.',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run test/brief/gather.test.ts`
Expected: FAIL, because `../../src/brief/gather.js` can't be resolved.

- [ ] **Step 3: Implement**

`src/brief/gather.ts`:
```ts
import type { Deps } from "../ports.js";
import type { Store } from "../store/types.js";
import { ACCOUNT_IDS, type AccountId, type CalendarEvent } from "../types.js";
import { HOUR_MS, addDaysToKey, formatSgt, sgtAt, sgtDateKey } from "../lib/clock.js";
import { loadHeldAlerts } from "../notify/held.js";
import type { BriefInput } from "./builder.js";

export type BriefKind = "morning" | "evening";

export const STALE_SYNC_MS = 2 * HOUR_MS;
export const STUCK_OUTBOX_ATTEMPTS = 3;
export const CALENDAR_DOWN = "⚠️ Couldn't load your calendar just now.";

const ACCOUNT_LABEL: Record<AccountId, string> = { personal: "Personal", school: "School" };

export async function gatherBriefInput(
  deps: Pick<Deps, "store" | "calendar" | "log">,
  kind: BriefKind,
  now: Date,
): Promise<BriefInput> {
  const { store } = deps;
  const settings = await store.settings.get();
  const today = sgtDateKey(now);
  const sinceIso = sgtAt(kind === "morning" ? addDaysToKey(today, -1) : today, settings.morningAt).toISOString();
  const day = kind === "morning" ? today : addDaysToKey(today, 1);

  const [openItems, importantEmails, failedEmails, overnightAlerts, health] = await Promise.all([
    store.items.list({ status: ["open"] }),
    store.emails.listImportantSince(sinceIso),
    store.emails.listFailedSince(sinceIso),
    loadHeldAlerts(store),
    healthLines(store, now),
  ]);

  let events: CalendarEvent[] = [];
  try {
    events = await deps.calendar.listEvents(
      sgtAt(day, "00:00").toISOString(),
      sgtAt(addDaysToKey(day, 1), "00:00").toISOString(),
    );
  } catch (err) {
    deps.log.warn("brief: calendar unavailable", { err, kind });
    health.push(CALENDAR_DOWN);
  }

  return { openItems, events, importantEmails, failedEmails, overnightAlerts, health, sinceIso };
}

export async function healthLines(store: Store, now: Date): Promise<string[]> {
  const lines: string[] = [];
  for (const id of ACCOUNT_IDS) {
    const acc = await store.accounts.get(id);
    if (!acc) continue;
    const label = ACCOUNT_LABEL[id];
    if (acc.authStatus === "revoked") {
      lines.push(`⚠️ ${label} account disconnected. Run \`npm run auth -- ${id}\` to reconnect.`);
    } else if (!acc.lastSyncAt) {
      lines.push(`⚠️ ${label} inbox hasn't synced yet. Reply "status" for details.`);
    } else if (now.getTime() - Date.parse(acc.lastSyncAt) > STALE_SYNC_MS) {
      const at = new Date(acc.lastSyncAt);
      const when = sgtDateKey(at) === sgtDateKey(now) ? formatSgt(at, "time") : formatSgt(at, "dayDateTime");
      lines.push(`⚠️ ${label} inbox not synced since ${when}. Reply "status" for details.`);
    }
  }
  const stuck = (await store.outbox.listPending())
    .filter((m) => m.lastError !== null && m.attempts >= STUCK_OUTBOX_ATTEMPTS).length;
  if (stuck > 0) {
    lines.push(`⚠️ ${stuck} WhatsApp ${stuck === 1 ? "message" : "messages"} couldn't be sent. Reply "status" for details.`);
  }
  return lines;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/brief && npm run typecheck`
Expected: `27 passed` (12 + 6 + 3 + 6), and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/brief/gather.ts test/brief/gather.test.ts
git commit -m "feat(brief): gather brief input with health lines"
```

---

### Task 7: Nudges

**Files:**
- Create: `src/scheduler/nudges.ts`
- Test: `test/scheduler/nudges.test.ts`

**Interfaces:**
- Consumes: `Store.items.list` (with `dueAfter`, which is inclusive, and `dueBefore`, which is exclusive), `isQuietTime`, `HOUR_MS`, and `itemBullet`, `dueTime`, `truncate` (Task 2).
- Produces: `sendNudges(deps: Pick<Deps, "store" | "outbox" | "log">, now: Date): Promise<"ok" | "skipped">` and `composeNudge(items: Item[], now: Date, leadHours: number): { text: string; template: TemplateRef }`.

Rules (§8.4):
- During quiet hours the step returns `"skipped"` and changes nothing, so the nudge is held.
- Candidates are open items with `now < dueAt <= now + nudgeLeadHours` and `nudgedAt === null`. Overdue items never qualify, so a deadline that passes during quiet hours is simply dropped.
- An item that was alerted within the last `nudgeLeadHours` gets no separate nudge, because the alert already covered it. It still gets `nudgedAt`.
- All due-soon items go into one message, sent with `outbox.deliver({kind:"nudge"})`. Then every candidate gets `nudgedAt = now`, so each item is nudged once.
- Nudges use bullets, not numbers, and don't overwrite `lastList`. That way a "done 3" that refers to the morning brief keeps working.

- [ ] **Step 1: Write the failing test**

`test/scheduler/nudges.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { sendNudges } from "../../src/scheduler/nudges.js";
import { makeSchedulerDeps } from "../helpers/scheduler-fakes.js";
import { makeItem } from "../store/contract.js";

const WED_1400 = "2026-10-14T06:00:00.000Z";

describe("sendNudges", () => {
  it("nudges an item due within 3h exactly once", async () => {
    const { deps, outbox } = makeSchedulerDeps(WED_1400);
    const i = await deps.store.items.create(makeItem({ dueAt: "2026-10-14T08:00:00.000Z" })); // 16:00 SGT
    expect(await sendNudges(deps, new Date(WED_1400))).toBe("ok");
    expect(outbox.sent).toEqual([{
      kind: "nudge",
      text: "⏳ *Due soon*\n• Submit consent form · by 4pm · Mr Tan",
      template: { name: "heads_up", params: ["Submit consent form, due 4pm"] },
    }]);
    expect((await deps.store.items.get(i.id))?.nudgedAt).toBe(WED_1400);
    expect(await sendNudges(deps, new Date("2026-10-14T06:05:00.000Z"))).toBe("skipped");
    expect(outbox.sent).toHaveLength(1);
  });

  it("ignores overdue, too-far, closed and snoozed items; includes exactly-3h", async () => {
    const { deps, outbox } = makeSchedulerDeps(WED_1400);
    await deps.store.items.create(makeItem({ title: "Overdue", dedupeKey: "a", dueAt: "2026-10-14T05:00:00.000Z" }));
    await deps.store.items.create(makeItem({ title: "Exactly three hours", dedupeKey: "b", dueAt: "2026-10-14T09:00:00.000Z" }));
    await deps.store.items.create(makeItem({ title: "Too far", dedupeKey: "c", dueAt: "2026-10-14T09:01:00.000Z" }));
    await deps.store.items.create(makeItem({ title: "Closed", dedupeKey: "d", dueAt: "2026-10-14T07:00:00.000Z", status: "done" }));
    await deps.store.items.create(makeItem({ title: "Snoozed", dedupeKey: "e", dueAt: "2026-10-14T07:00:00.000Z",
      status: "snoozed", snoozedUntil: "2026-10-15T00:00:00.000Z" }));
    expect(await sendNudges(deps, new Date(WED_1400))).toBe("ok");
    expect(outbox.sent.map((m) => m.text)).toEqual(["⏳ *Due soon*\n• Exactly three hours · by 5pm · Mr Tan"]);
  });

  it("holds nudges in quiet hours and drops one whose deadline passes overnight", async () => {
    const night = "2026-10-14T14:45:00.000Z"; // Wed 22:45 SGT
    const { deps, outbox } = makeSchedulerDeps(night);
    const i = await deps.store.items.create(makeItem({ dueAt: "2026-10-14T15:30:00.000Z" })); // 23:30 SGT
    expect(await sendNudges(deps, new Date(night))).toBe("skipped");
    expect((await deps.store.items.get(i.id))?.nudgedAt).toBeNull();
    expect(await sendNudges(deps, new Date("2026-10-14T22:30:00.000Z"))).toBe("skipped"); // Thu 06:30, now overdue
    expect(outbox.sent).toEqual([]);
  });

  it("does not nudge an item that was just alerted, but records it as nudged", async () => {
    const { deps, outbox } = makeSchedulerDeps(WED_1400);
    const i = await deps.store.items.create(makeItem({ dueAt: "2026-10-14T08:00:00.000Z", alertedAt: "2026-10-14T05:30:00.000Z" }));
    expect(await sendNudges(deps, new Date(WED_1400))).toBe("skipped");
    expect(outbox.sent).toEqual([]);
    expect((await deps.store.items.get(i.id))?.nudgedAt).toBe(WED_1400);
  });

  it("groups several due-soon items into one message", async () => {
    const { deps, outbox } = makeSchedulerDeps(WED_1400);
    await deps.store.items.create(makeItem({ title: "First", dedupeKey: "a", dueAt: "2026-10-14T07:00:00.000Z" }));
    await deps.store.items.create(makeItem({ title: "Second", dedupeKey: "b", dueAt: "2026-10-14T08:00:00.000Z" }));
    expect(await sendNudges(deps, new Date(WED_1400))).toBe("ok");
    expect(outbox.sent).toEqual([{
      kind: "nudge",
      text: "⏳ *Due soon*\n• First · by 3pm · Mr Tan\n• Second · by 4pm · Mr Tan",
      template: { name: "heads_up", params: ["2 things due in the next 3h"] },
    }]);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run test/scheduler/nudges.test.ts`
Expected: FAIL, because `../../src/scheduler/nudges.js` can't be resolved.

- [ ] **Step 3: Implement**

`src/scheduler/nudges.ts`:
```ts
import type { Deps } from "../ports.js";
import type { Item, TemplateRef } from "../types.js";
import { HOUR_MS, isQuietTime } from "../lib/clock.js";
import { dueTime, itemBullet, truncate } from "../brief/format.js";

const SUMMARY_MAX = 60;

export function composeNudge(items: Item[], now: Date, leadHours: number): { text: string; template: TemplateRef } {
  const text = ["⏳ *Due soon*", ...items.map((i) => itemBullet(i, now))].join("\n");
  const [first] = items;
  const summary = items.length === 1 && first?.dueAt
    ? `${truncate(first.title, 45)}, due ${dueTime(first.dueAt)}`
    : `${items.length} things due in the next ${leadHours}h`;
  return { text, template: { name: "heads_up", params: [truncate(summary, SUMMARY_MAX)] } };
}

export async function sendNudges(deps: Pick<Deps, "store" | "outbox" | "log">, now: Date): Promise<"ok" | "skipped"> {
  const { store } = deps;
  const settings = await store.settings.get();
  if (isQuietTime(now, settings.quietStart, settings.quietEnd)) return "skipped";

  const nowIso = now.toISOString();
  const leadMs = settings.nudgeLeadHours * HOUR_MS;
  const candidates = (await store.items.list({
    status: ["open"],
    dueAfter: nowIso,
    dueBefore: new Date(now.getTime() + leadMs + 1).toISOString(), // dueBefore is exclusive; include exactly +lead
  })).filter((i) => i.nudgedAt === null && i.dueAt !== null && i.dueAt > nowIso);
  if (candidates.length === 0) return "skipped";

  const alertedRecently = (i: Item) => i.alertedAt !== null && Date.parse(i.alertedAt) >= now.getTime() - leadMs;
  const toNudge = candidates.filter((i) => !alertedRecently(i));
  if (toNudge.length > 0) {
    const nudge = composeNudge(toNudge, now, settings.nudgeLeadHours);
    await deps.outbox.deliver({ kind: "nudge", text: nudge.text, template: nudge.template });
  }
  for (const i of candidates) await store.items.update(i.id, { nudgedAt: nowIso });
  deps.log.info("nudges", { sent: toNudge.length, recorded: candidates.length });
  return toNudge.length > 0 ? "ok" : "skipped";
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/scheduler/nudges.test.ts && npm run typecheck`
Expected: `5 passed`, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/nudges.ts test/scheduler/nudges.test.ts
git commit -m "feat(scheduler): deadline nudges with quiet-hours hold"
```

---

### Task 8: Sending the morning and evening brief

**Files:**
- Create: `src/scheduler/briefs.ts`
- Test: `test/scheduler/briefs.test.ts`

**Interfaces:**
- Consumes: `gatherBriefInput` and `BriefKind` (Task 6), `composeMorning` (Task 3), `composeEvening` (Task 4), `markAlerted` and `pruneHeldAlerts` (Task 5), `store.processed.claim`, and `state/briefs` and `state/lastList`.
- Produces: `maybeSendBrief(deps: Pick<Deps, "store" | "calendar" | "outbox" | "log">, kind: BriefKind, now: Date): Promise<"ok" | "skipped">`.

Rules (§8.5):
- If the brief was already sent today (SGT date key in `state/briefs`), return `"skipped"`.
- If it's before that brief's time today, return `"skipped"`.
- **Morning only:** if `now >= eveningAt`, mark the morning as done for today without sending it, log a warning and return `"skipped"`. The evening brief goes out instead.
- Otherwise, gather and compose. Then claim `brief:<kind>:<dateKey>` with `store.processed.claim` *right before* delivering. Doing the claim after gather and compose means a gather failure leaves the brief unclaimed, so the next tick retries it. If the claim is lost, return `"skipped"` because another tick is sending it.
- After delivering: save `numbering` to `state/lastList`, set `state/briefs`, mark the overnight alerts as alerted, and prune the held list.

- [ ] **Step 1: Write the failing test**

`test/scheduler/briefs.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run test/scheduler/briefs.test.ts`
Expected: FAIL, because `../../src/scheduler/briefs.js` can't be resolved.

- [ ] **Step 3: Implement**

`src/scheduler/briefs.ts`:
```ts
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
  await markAlerted(store, input.overnightAlerts.map((i) => i.id), nowIso);
  await pruneHeldAlerts(store);
  deps.log.info("brief sent", { kind, date: today, ...brief.counts });
  return "ok";
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/scheduler/briefs.test.ts && npm run typecheck`
Expected: `6 passed`, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/briefs.ts test/scheduler/briefs.test.ts
git commit -m "feat(scheduler): send morning/evening brief once per day with catch-up"
```

---

### Task 9: `tick`

**Files:**
- Create: `src/scheduler/tick.ts`
- Test: `test/scheduler/tick.test.ts`

**Interfaces:**
- Consumes: `Deps` (`mail.syncAccount`, `mail.retryPendingTriage`, `mail.renewWatchIfNeeded`, `classroom.syncIfDue`, `notifier.sendAlerts`, `outbox.deliver`, `outbox.flush`, and `store.*`), `sendNudges` (Task 7), `maybeSendBrief` (Task 8), `truncate` (Task 2) and `ACCOUNT_IDS`.
- Produces:
  ```ts
  type TickReport = Record<string, "ok" | "skipped" | { error: string }>;
  tick(deps: Deps, now?: Date): Promise<TickReport>   // now defaults to deps.clock.now()
  ```

The steps run in this order, and the report keys are added in the same order:
1. `sync:personal`, `sync:school`
2. `retryTriage`
3. `classroom`
4. `alerts`, which collects the alerts from steps 1–3 and passes them to `deps.notifier.sendAlerts` in one call (`"skipped"` if there are none)
5. `wakeSnoozed`, which reopens items where `snoozedUntil <= now`
6. `reminders`, which delivers due reminders with `kind: "reminder"`, text `⏰ <text>` and template `heads_up ["Reminder: <text>"]`, then marks each one `sent`. **Reminders ignore quiet hours.**
7. `nudges`
8. `brief:morning`, `brief:evening`
9. `outboxFlush`
10. `watch:personal`, `watch:school`
11. `purge`, which calls `processed.purgeOlderThan(now - 7 days)`

A step that throws is recorded as `{ error: message }` and logged, and the remaining steps continue.

- [ ] **Step 1: Write the failing test**

`test/scheduler/tick.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { tick } from "../../src/scheduler/tick.js";
import { EMPTY_SYNC } from "../../src/ports.js";
import type { Item } from "../../src/types.js";
import { fakeClassroom, fakeMail, makeSchedulerDeps } from "../helpers/scheduler-fakes.js";
import { makeItem } from "../store/contract.js";

const WED_1000 = "2026-10-14T02:00:00.000Z";
const MORNING_SENT = { lastMorningDate: "2026-10-14", lastEveningDate: null };

describe("tick", () => {
  it("runs every step in order and reports each one", async () => {
    const calls: string[] = [];
    const { deps, outbox } = makeSchedulerDeps(WED_1000, {
      mail: fakeMail({
        syncAccount: async (a) => { calls.push(`sync:${a}`); return EMPTY_SYNC; },
        retryPendingTriage: async () => { calls.push("retry"); return EMPTY_SYNC; },
        renewWatchIfNeeded: async (a) => { calls.push(`watch:${a}`); },
      }),
      classroom: fakeClassroom({ syncIfDue: async () => { calls.push("classroom"); return EMPTY_SYNC; } }),
    });
    await deps.store.state.set("briefs", MORNING_SENT);

    const report = await tick(deps);

    expect(Object.keys(report)).toEqual([
      "sync:personal", "sync:school", "retryTriage", "classroom", "alerts", "wakeSnoozed", "reminders",
      "nudges", "brief:morning", "brief:evening", "outboxFlush", "watch:personal", "watch:school", "purge",
    ]);
    expect(report).toEqual({
      "sync:personal": "ok", "sync:school": "ok", retryTriage: "ok", classroom: "ok", alerts: "skipped",
      wakeSnoozed: "skipped", reminders: "skipped", nudges: "skipped", "brief:morning": "skipped",
      "brief:evening": "skipped", outboxFlush: "ok", "watch:personal": "ok", "watch:school": "ok", purge: "ok",
    });
    expect(calls).toEqual(["sync:personal", "sync:school", "retry", "classroom", "watch:personal", "watch:school"]);
    expect(outbox.flushes).toBe(1);
    expect(outbox.sent).toEqual([]);
  });

  it("a failing step is reported and the rest still run", async () => {
    const watched: string[] = [];
    const { deps } = makeSchedulerDeps(WED_1000, {
      mail: fakeMail({
        syncAccount: async (a) => {
          if (a === "school") throw new Error("school sync exploded");
          return EMPTY_SYNC;
        },
        renewWatchIfNeeded: async (a) => { watched.push(a); },
      }),
    });
    await deps.store.state.set("briefs", MORNING_SENT);
    const report = await tick(deps);
    expect(report["sync:school"]).toEqual({ error: "school sync exploded" });
    expect(report["sync:personal"]).toBe("ok");
    expect(report.purge).toBe("ok");
    expect(watched).toEqual(["personal", "school"]);
  });

  it("alerts from sync, retry and classroom go out as one grouped message", async () => {
    let a!: Item;
    let b!: Item;
    const { deps, outbox } = makeSchedulerDeps(WED_1000, {
      mail: fakeMail({ syncAccount: async (acc) => (acc === "personal" ? { ...EMPTY_SYNC, alerts: [a] } : EMPTY_SYNC) }),
      classroom: fakeClassroom({ syncIfDue: async () => ({ ...EMPTY_SYNC, alerts: [b] }) }),
    });
    a = await deps.store.items.create(makeItem({ title: "Reply to Mr Tan", urgency: "urgent", dedupeKey: "a" }));
    b = await deps.store.items.create(makeItem({ title: "Maths quiz moved", urgency: "urgent", dedupeKey: "b" }));
    await deps.store.state.set("briefs", MORNING_SENT);

    const report = await tick(deps);

    expect(report.alerts).toBe("ok");
    const alerts = outbox.sent.filter((m) => m.kind === "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain("Reply to Mr Tan");
    expect(alerts[0]?.text).toContain("Maths quiz moved");
  });

  it("an alert during quiet hours is held, then lands in the next morning brief", async () => {
    let pending: Item[] = [];
    const { deps, outbox } = makeSchedulerDeps("2026-10-14T15:00:00.000Z", { // Wed 23:00 SGT
      mail: fakeMail({
        syncAccount: async (acc) => {
          if (acc !== "personal") return EMPTY_SYNC;
          const alerts = pending;
          pending = [];
          return { ...EMPTY_SYNC, alerts };
        },
      }),
    });
    await deps.store.state.set("briefs", { lastMorningDate: "2026-10-14", lastEveningDate: "2026-10-14" });
    const camp = await deps.store.items.create(makeItem({ title: "Camp form", urgency: "urgent", dedupeKey: "camp" }));
    pending = [camp];

    const night = await tick(deps);
    expect(night.alerts).toBe("ok");
    expect(outbox.sent).toEqual([]);

    deps.clock.set("2026-10-14T22:30:00.000Z"); // Thu 06:30 SGT
    const morning = await tick(deps);
    expect(morning["brief:morning"]).toBe("ok");
    expect(outbox.sent.map((m) => m.kind)).toEqual(["morning"]);
    expect(outbox.sent[0]?.text).toContain("*Good morning! Thu 15 Oct* ☀️");
    expect(outbox.sent[0]?.text).toContain("*🌙 Came in overnight*\n1. Camp form · Mr Tan");
    expect((await deps.store.items.get(camp.id))?.alertedAt).toBe("2026-10-14T22:30:00.000Z");
  });

  it("reminders fire even in quiet hours and are marked sent", async () => {
    const { deps, outbox } = makeSchedulerDeps("2026-10-14T15:00:00.000Z"); // Wed 23:00 SGT
    await deps.store.state.set("briefs", { lastMorningDate: "2026-10-14", lastEveningDate: "2026-10-14" });
    const base = { status: "pending" as const, itemId: null, createdAt: "2026-10-14T10:00:00.000Z" };
    await deps.store.reminders.create({ ...base, text: "Pack PE kit", fireAt: "2026-10-14T14:55:00.000Z" });
    await deps.store.reminders.create({ ...base, text: "Later", fireAt: "2026-10-15T01:00:00.000Z" });

    const report = await tick(deps);

    expect(report.reminders).toBe("ok");
    expect(outbox.sent).toEqual([{
      kind: "reminder", text: "⏰ Pack PE kit", template: { name: "heads_up", params: ["Reminder: Pack PE kit"] },
    }]);
    expect((await deps.store.reminders.listPending()).map((r) => r.text)).toEqual(["Later"]);
  });

  it("snoozed + overdue item stays hidden until woken, then shows as overdue and is never nudged", async () => {
    const now = "2026-10-13T22:30:00.000Z"; // Wed 06:30 SGT
    const { deps, outbox } = makeSchedulerDeps(now);
    const chem = await deps.store.items.create(makeItem({ title: "Chem practical write-up", dedupeKey: "chem",
      dueAt: "2026-10-12T15:59:00.000Z", status: "snoozed", snoozedUntil: "2026-10-13T22:00:00.000Z" }));
    const art = await deps.store.items.create(makeItem({ title: "Art portfolio", dedupeKey: "art",
      dueAt: "2026-10-12T15:59:00.000Z", status: "snoozed", snoozedUntil: "2026-10-16T00:00:00.000Z" }));

    const report = await tick(deps);

    expect(report.wakeSnoozed).toBe("ok");
    expect(await deps.store.items.get(chem.id)).toMatchObject({ status: "open", snoozedUntil: null });
    expect((await deps.store.items.get(art.id))?.status).toBe("snoozed");
    const brief = outbox.sent.find((m) => m.kind === "morning");
    expect(brief?.text).toContain("*⚠️ Overdue*\n1. Chem practical write-up (was due Mon) · Mr Tan");
    expect(brief?.text).not.toContain("Art portfolio");
    expect(outbox.sent.some((m) => m.kind === "nudge")).toBe(false);
  });

  it("purges processed keys older than 7 days", async () => {
    const { deps } = makeSchedulerDeps(WED_1000);
    await deps.store.state.set("briefs", MORNING_SENT);
    await deps.store.processed.claim("old", "2026-10-01T00:00:00.000Z");
    await deps.store.processed.claim("recent", "2026-10-13T00:00:00.000Z");
    await tick(deps);
    expect(await deps.store.processed.claim("old", WED_1000)).toBe(true);
    expect(await deps.store.processed.claim("recent", WED_1000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run test/scheduler/tick.test.ts`
Expected: FAIL, because `../../src/scheduler/tick.js` can't be resolved.

- [ ] **Step 3: Implement**

`src/scheduler/tick.ts`:
```ts
import type { Deps } from "../ports.js";
import { ACCOUNT_IDS, type Item } from "../types.js";
import { HOUR_MS } from "../lib/clock.js";
import { truncate } from "../brief/format.js";
import { sendNudges } from "./nudges.js";
import { maybeSendBrief } from "./briefs.js";

export type StepResult = "ok" | "skipped" | { error: string };
export type TickReport = Record<string, StepResult>;

const PROCESSED_TTL_MS = 7 * 24 * HOUR_MS;

async function wakeSnoozed(deps: Deps, now: Date): Promise<"ok" | "skipped"> {
  const nowIso = now.toISOString();
  const due = (await deps.store.items.list({ status: ["snoozed"] }))
    .filter((i) => i.snoozedUntil !== null && i.snoozedUntil <= nowIso);
  for (const i of due) await deps.store.items.update(i.id, { status: "open", snoozedUntil: null, updatedAt: nowIso });
  return due.length > 0 ? "ok" : "skipped";
}

async function fireReminders(deps: Deps, now: Date): Promise<"ok" | "skipped"> {
  const due = await deps.store.reminders.listDue(now.toISOString());
  if (due.length === 0) return "skipped";
  let failed = 0;
  for (const r of due) {
    try {
      await deps.outbox.deliver({
        kind: "reminder",
        text: `⏰ ${r.text}`,
        template: { name: "heads_up", params: [truncate(`Reminder: ${r.text}`, 60)] },
      });
      await deps.store.reminders.update(r.id, { status: "sent" });
    } catch (err) {
      failed += 1;
      deps.log.error("reminder failed", { reminderId: r.id, err });
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${due.length} reminders failed`);
  return "ok";
}

export async function tick(deps: Deps, now: Date = deps.clock.now()): Promise<TickReport> {
  const report: TickReport = {};
  const log = deps.log.child({ tickAt: now.toISOString() });

  const step = async (name: string, fn: () => Promise<"ok" | "skipped" | void>): Promise<void> => {
    try {
      const result = await fn();
      report[name] = result === "skipped" ? "skipped" : "ok";
    } catch (err) {
      report[name] = { error: err instanceof Error ? err.message : String(err) };
      log.error("tick step failed", { step: name, err });
    }
  };

  const alerts: Item[] = [];
  for (const account of ACCOUNT_IDS) {
    await step(`sync:${account}`, async () => {
      alerts.push(...(await deps.mail.syncAccount(account)).alerts);
    });
  }
  await step("retryTriage", async () => {
    alerts.push(...(await deps.mail.retryPendingTriage()).alerts);
  });
  await step("classroom", async () => {
    alerts.push(...(await deps.classroom.syncIfDue()).alerts);
  });
  await step("alerts", async () => {
    if (alerts.length === 0) return "skipped";
    await deps.notifier.sendAlerts(alerts);
  });
  await step("wakeSnoozed", () => wakeSnoozed(deps, now));
  await step("reminders", () => fireReminders(deps, now));
  await step("nudges", () => sendNudges(deps, now));
  await step("brief:morning", () => maybeSendBrief(deps, "morning", now));
  await step("brief:evening", () => maybeSendBrief(deps, "evening", now));
  await step("outboxFlush", async () => {
    await deps.outbox.flush();
  });
  for (const account of ACCOUNT_IDS) {
    await step(`watch:${account}`, () => deps.mail.renewWatchIfNeeded(account));
  }
  await step("purge", async () => {
    await deps.store.processed.purgeOlderThan(new Date(now.getTime() - PROCESSED_TTL_MS).toISOString());
  });

  log.info("tick done", { report });
  return report;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/scheduler && npm run typecheck`
Expected: `18 passed` (5 nudges + 6 briefs + 7 tick), and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/tick.ts test/scheduler/tick.test.ts
git commit -m "feat(scheduler): tick orchestrates sync, alerts, reminders, nudges, briefs, renewal and purge"
```

---

### Task 10: `POST /jobs/tick` route

**Files:**
- Create: `src/scheduler/routes.ts`
- Test: `test/scheduler/routes.test.ts`

**Interfaces:**
- Consumes: `RouteRegistrar` and `buildServer` (`src/server.ts`), `oidcPreHandler` and `IdTokenVerifier` (`src/http/oidc.ts`), `createNotifier` (Task 5) and `tick` (Task 9).
- Produces: `registerJobRoutes: RouteRegistrar` (the production one), and `jobRoutes(verify?: IdTokenVerifier): RouteRegistrar`, which tests use to inject a fake verifier.

Behavior:
- `POST /jobs/tick` is protected by `oidcPreHandler(deps)`. It runs `tick(deps)` and returns 200 with the `TickReport` as JSON.
- When `config.DEV_SKIP_OIDC` is true, `?now=<ISO>` sets the time. The route builds a copy of `deps` with a fixed clock and a fresh notifier bound to that clock, then runs `tick(devDeps, at)`. An invalid `now` returns 400. Without `DEV_SKIP_OIDC`, `?now` is ignored.
- The route never reads a body. Cloud Scheduler may send an empty body with `Content-Type: application/json`, which Fastify's default JSON parser rejects. So this encapsulated scope replaces the body parsers with a catch-all that ignores the body.

- [ ] **Step 1: Write the failing test**

`test/scheduler/routes.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/server.js";
import { jobRoutes, registerJobRoutes } from "../../src/scheduler/routes.js";
import { loadConfig } from "../../src/config.js";
import type { IdTokenVerifier } from "../../src/http/oidc.js";
import { TEST_ENV } from "../helpers/env.js";
import { makeSchedulerDeps } from "../helpers/scheduler-fakes.js";

const WED_0800 = "2026-10-14T00:00:00.000Z";
const INVOKER = TEST_ENV.INVOKER_SERVICE_ACCOUNT!;
const okVerifier: IdTokenVerifier = async (token, audience) =>
  token === "good" && audience === "https://bot.example.com/jobs/tick" ? { email: INVOKER, email_verified: true } : undefined;
const devConfig = loadConfig({ ...TEST_ENV, DEV_SKIP_OIDC: "true" });

describe("POST /jobs/tick", () => {
  it("rejects calls without an OIDC token", async () => {
    const { deps } = makeSchedulerDeps(WED_0800);
    const app = await buildServer(deps, [registerJobRoutes]);
    expect((await app.inject({ method: "POST", url: "/jobs/tick" })).statusCode).toBe(401);
  });

  it("runs the tick at the real time with a valid token and ignores ?now", async () => {
    const { deps, outbox } = makeSchedulerDeps(WED_0800);
    const app = await buildServer(deps, [jobRoutes(okVerifier)]);
    const res = await app.inject({
      method: "POST", url: "/jobs/tick?now=2026-10-13T13:05:00.000Z", headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ "brief:morning": "ok", "brief:evening": "skipped" });
    expect(outbox.sent[0]?.text).toContain("*Good morning! Wed 14 Oct* ☀️");
  });

  it("with DEV_SKIP_OIDC, ?now sets the time", async () => {
    const { deps, outbox } = makeSchedulerDeps(WED_0800, { config: devConfig });
    const app = await buildServer(deps, [registerJobRoutes]);
    const res = await app.inject({ method: "POST", url: "/jobs/tick?now=2026-10-13T13:05:00.000Z" }); // Tue 21:05 SGT
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ "brief:morning": "skipped", "brief:evening": "ok" });
    expect(outbox.sent.map((m) => m.kind)).toEqual(["evening"]);
    expect(outbox.sent[0]?.text).toContain("*Evening check-in · Tue 13 Oct* 🌙");
  });

  it("with DEV_SKIP_OIDC, an invalid ?now is a 400", async () => {
    const { deps } = makeSchedulerDeps(WED_0800, { config: devConfig });
    const app = await buildServer(deps, [registerJobRoutes]);
    const res = await app.inject({ method: "POST", url: "/jobs/tick?now=yesterday-ish" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid now" });
  });

  it("accepts an empty JSON body from Cloud Scheduler", async () => {
    const { deps } = makeSchedulerDeps(WED_0800, { config: devConfig });
    const app = await buildServer(deps, [registerJobRoutes]);
    const res = await app.inject({
      method: "POST", url: "/jobs/tick", headers: { "content-type": "application/json" }, payload: "",
    });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run test/scheduler/routes.test.ts`
Expected: FAIL, because `../../src/scheduler/routes.js` can't be resolved.

- [ ] **Step 3: Implement**

`src/scheduler/routes.ts`:
```ts
import type { RouteRegistrar } from "../server.js";
import type { Deps } from "../ports.js";
import { oidcPreHandler, type IdTokenVerifier } from "../http/oidc.js";
import { createNotifier } from "../notify/notifier.js";
import { tick } from "./tick.js";

export function jobRoutes(verify?: IdTokenVerifier): RouteRegistrar {
  return (app, deps) => {
    // This scope never reads a body. Cloud Scheduler may POST an empty body with any content type.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "string" }, (_request, _body, done) => done(null, undefined));

    app.post("/jobs/tick", { preHandler: oidcPreHandler(deps, verify) }, async (request, reply) => {
      const { now: nowParam } = request.query as { now?: string };
      if (deps.config.DEV_SKIP_OIDC && nowParam) {
        const at = new Date(nowParam);
        if (Number.isNaN(at.getTime())) return reply.code(400).send({ error: "invalid now" });
        const devDeps: Deps = { ...deps, clock: { now: () => new Date(at.getTime()) } };
        devDeps.notifier = createNotifier(devDeps);
        deps.log.warn("tick with overridden time (DEV_SKIP_OIDC)", { now: at.toISOString() });
        return tick(devDeps, at);
      }
      return tick(deps);
    });
  };
}

export const registerJobRoutes: RouteRegistrar = jobRoutes();
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: every test passes (`routes.test.ts`: 5 passed), the Firestore suite is skipped without the emulator, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/routes.ts test/scheduler/routes.test.ts
git commit -m "feat(scheduler): POST /jobs/tick route with OIDC and dev time override"
```

---

## Self-review

**Spec coverage:**
- §8.2 morning layout → Task 3. Evening layout → Task 4. Health line → Task 6, rendered in Tasks 3 and 4. Numbering saved to `lastList` → Tasks 3 and 8.
- §7a 🗓 Today and Tomorrow events → Tasks 3, 4 and 6.
- §7 couldn't-read emails → Tasks 1, 2, 3 and 6.
- §8.1 `brief_ready` and `heads_up` templates → Tasks 3, 5, 7 and 9.
- §8.3 grouping, quiet-hours hold and fold-in → Tasks 5 and 8.
- §8.4 reminders ignore quiet hours → Task 9. Nudges once, held, dropped → Task 7.
- §8.5 order and catch-up → Tasks 8 and 9. The order follows the coordinator's list, which adds the classroom, alerts, snooze-wake and flush steps to §8.5.
- §10 a tick step that throws → Task 9. WhatsApp failures stuck in the outbox → the health line in Task 6.
- §11 snapshot tests → Tasks 3 and 4. Fake-clock tick tests for quiet hours, missed tick and catch-up, and watch renewal → Tasks 8 and 9. Local end-to-end `POST /jobs/tick` with a fake time → Task 10.

**Type consistency:**
- `BriefInput` is defined once in `builder.ts` and imported by `morning.ts`, `evening.ts` and `gather.ts`.
- `BriefKind` is defined in `gather.ts` and used by `briefs.ts`.
- `LineMode` is defined in `format.ts`.
- `TickReport` is exported from `tick.ts`.
- `createNotifier(deps: Pick<Deps, "clock" | "log" | "store" | "outbox">)` matches the coordinator's signature.
- `gatherBriefInput(deps, kind, now)` takes `Pick<Deps, "store" | "calendar" | "log">`, so a full `Deps` is accepted.

**Deliberate interpretations (flag these in review):**
- The "important since" window is the *previous morning brief*, not the previous brief of any kind. See the reasoning in Task 6.
- The evening `brief_ready` label is `"Wed evening"`.
- Nudges don't overwrite `lastList`, but alerts do, as requested.
