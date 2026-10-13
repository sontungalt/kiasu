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
