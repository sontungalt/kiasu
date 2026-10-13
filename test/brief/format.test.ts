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
