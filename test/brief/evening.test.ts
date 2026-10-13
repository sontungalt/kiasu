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
