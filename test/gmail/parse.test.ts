import { describe, it, expect } from "vitest";
import { parseGmailMessage, searchHitFromMessage, decodeBase64Url, MAX_TEXT_CHARS } from "../../src/gmail/parse.js";
import type { GmailMessage } from "../../src/gmail/api.js";
import {
  b64, multipartAlternative, htmlOnly, nestedWithAttachment, missingHeaders, garbageDate, headerDateOnly,
  imageOnly, metadataOnly,
} from "../fixtures/gmail-messages.js";

const FALLBACK = new Date("2026-10-14T00:00:00Z");

describe("parseGmailMessage", () => {
  it("multipart/alternative prefers text/plain and normalises whitespace", () => {
    expect(parseGmailMessage(multipartAlternative, "school", FALLBACK)).toEqual({
      id: "m-alt",
      account: "school",
      threadId: "t-alt",
      from: "Mr Tan <tan_ak@school.edu.sg>",
      to: "Me <me@students.school.edu.sg>",
      subject: "CCA consent form",
      date: "2026-10-14T01:15:02.000Z",
      text: "Hi class,\nPlease submit the CCA consent form by Friday 3pm.\n\nMr Tan",
      attachments: [],
      labelIds: ["INBOX", "UNREAD"],
      truncated: false,
    });
  });

  it("HTML-only converts to readable text without links, images or CSS", () => {
    const p = parseGmailMessage(htmlOnly, "school", FALLBACK);
    expect(p.text).toContain("Term 4 Newsletter");
    expect(p.text).toContain("Sports day is on Fri 24 Oct.");
    expect(p.text).toContain("Details");
    expect(p.text).toMatch(/Venue\n+School hall/);
    expect(p.text).not.toMatch(/token|banner|color|TERM 4/);
    expect(p.date).toBe("2026-10-13T02:00:00.000Z");
  });

  it("nested multipart: decodes the part charset and collects every attachment name", () => {
    const p = parseGmailMessage(nestedWithAttachment, "school", FALLBACK);
    expect(p.text).toBe("Café menu attached.");
    expect(p.attachments).toEqual(["logo.png", "Consent Form.pdf"]);
  });

  it("missing headers fall back to placeholders and the fallback date", () => {
    const p = parseGmailMessage(missingHeaders, "personal", FALLBACK);
    expect(p).toMatchObject({
      from: "(unknown sender)", to: "", subject: "(no subject)",
      date: "2026-10-14T00:00:00.000Z", text: "hello", attachments: [],
    });
  });

  it("garbage Date header with no internalDate uses the fallback; a valid header is used when internalDate is missing", () => {
    expect(parseGmailMessage(garbageDate, "personal", FALLBACK).date).toBe("2026-10-14T00:00:00.000Z");
    expect(parseGmailMessage(headerDateOnly, "personal", FALLBACK).date).toBe("2026-10-14T15:50:00.000Z");
  });

  it("caps text at 30,000 characters and flags truncated", () => {
    const msg: GmailMessage = {
      id: "m-long", threadId: "t-long", labelIds: ["INBOX"], internalDate: "1760400000000",
      payload: { mimeType: "text/plain", headers: [], body: { size: 50_000, data: b64("word ".repeat(10_000)) } },
    };
    const p = parseGmailMessage(msg, "personal", FALLBACK);
    expect(p.text).toHaveLength(MAX_TEXT_CHARS);
    expect(p.truncated).toBe(true);
  });

  it("handles a 2 MB HTML newsletter quickly and caps the text", () => {
    const row = '<tr><td style="padding:4px"><p>Weekly news paragraph with <b>bold</b> text and <a href="https://example.com/x">a link</a>.</p></td></tr>';
    const html = `<html><body><table>${row.repeat(Math.ceil(2_000_000 / row.length))}</table></body></html>`;
    const msg: GmailMessage = {
      id: "m-big", threadId: "t-big", labelIds: ["INBOX"], internalDate: "1760400000000",
      payload: { mimeType: "text/html", headers: [], body: { size: html.length, data: b64(html) } },
    };
    const started = performance.now();
    const p = parseGmailMessage(msg, "personal", FALLBACK);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(p.text).toHaveLength(MAX_TEXT_CHARS);
    expect(p.truncated).toBe(true);
    expect(p.text).toContain("Weekly news paragraph");
  });

  it("image-only email gives empty text, not an error", () => {
    const p = parseGmailMessage(imageOnly, "school", FALLBACK);
    expect(p.text).toBe("");
    expect(p.truncated).toBe(false);
    expect(p.attachments).toEqual(["poster.jpg"]);
    expect(p.subject).toBe("Poster");
  });
});

describe("helpers", () => {
  it("decodeBase64Url accepts url-safe and standard alphabets", () => {
    expect(decodeBase64Url("aGk_Pz8")).toBe("hi???");
    expect(decodeBase64Url("aGk/Pz8=")).toBe("hi???");
  });

  it("searchHitFromMessage reads metadata headers and decodes snippet entities", () => {
    expect(searchHitFromMessage(metadataOnly, "school")).toEqual({
      id: "m-meta",
      account: "school",
      threadId: "t-meta",
      from: "Ms Lee <lee@school.edu.sg>",
      subject: "PE tomorrow",
      date: "2026-10-14T05:00:00.000Z",
      snippet: 'Don\'t forget & bring your "PE kit"',
    });
  });
});
