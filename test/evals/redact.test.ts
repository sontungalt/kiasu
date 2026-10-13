import { describe, it, expect } from "vitest";
import { redactText, redactParsed } from "../../evals/triage/redact.js";
import type { ParsedEmail } from "../../src/types.js";

describe("redact", () => {
  it("replaces email local parts but keeps domains", () => {
    expect(redactText("Mr Tan <tan_ah_kow@school.edu.sg>, cc me@students.school.edu.sg"))
      .toBe("Mr Tan <redacted@school.edu.sg>, cc redacted@students.school.edu.sg");
  });

  it("redacts phones, NRICs, long numbers and URL queries, but not dates and times", () => {
    expect(redactText("Call 9123 4567 or +65 6123-4567. NRIC S1234567D. Ref 123456789012."))
      .toBe("Call [PHONE] or [PHONE]. NRIC [NRIC]. Ref [NUMBER].");
    expect(redactText("Pay at https://pay.example.com/inv?id=abc&t=xyz now"))
      .toBe("Pay at https://pay.example.com/inv?[redacted] now");
    const dates = "Due Fri 17 Oct 2026, 3:30pm (2026-10-17). Room 3-12.";
    expect(redactText(dates)).toBe(dates);
  });

  it("redactParsed covers from/to/subject/text/attachments and keeps ids, date and labels", () => {
    const p: ParsedEmail = {
      id: "m1", account: "school", threadId: "t1", from: "Mr Tan <tan@school.edu.sg>", to: "me@students.school.edu.sg",
      subject: "Call 9123 4567", text: "Email lim@school.edu.sg", attachments: ["S1234567D.pdf"],
      date: "2026-10-14T00:00:00.000Z", labelIds: ["INBOX"], truncated: false,
    };
    expect(redactParsed(p)).toEqual({
      ...p,
      from: "Mr Tan <redacted@school.edu.sg>", to: "redacted@students.school.edu.sg",
      subject: "Call [PHONE]", text: "Email redacted@school.edu.sg", attachments: ["[NRIC].pdf"],
    });
  });
});
