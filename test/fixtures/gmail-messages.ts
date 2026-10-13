import type { GmailMessage } from "../../src/gmail/api.js";

export const b64 = (s: string, enc: BufferEncoding = "utf8") => Buffer.from(s, enc).toString("base64url");
const h = (name: string, value: string) => ({ name, value });
const ms = (iso: string) => String(Date.parse(iso));

const STD_HEADERS = [
  h("From", "Mr Tan <tan_ak@school.edu.sg>"),
  h("To", "Me <me@students.school.edu.sg>"),
  h("Subject", "CCA consent form"),
  h("Date", "Wed, 14 Oct 2026 09:15:00 +0800"),
];

export const multipartAlternative: GmailMessage = {
  id: "m-alt",
  threadId: "t-alt",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "Hi class",
  internalDate: ms("2026-10-14T01:15:02Z"),
  payload: {
    partId: "",
    mimeType: "multipart/alternative",
    filename: "",
    headers: [...STD_HEADERS, h("Content-Type", 'multipart/alternative; boundary="000"')],
    body: { size: 0 },
    parts: [
      {
        partId: "0",
        mimeType: "text/plain",
        filename: "",
        headers: [h("Content-Type", 'text/plain; charset="UTF-8"')],
        body: { size: 70, data: b64("Hi class,  \r\nPlease submit the CCA consent form by Friday 3pm.\r\n\r\n\r\n\r\nMr Tan\r\n") },
      },
      {
        partId: "1",
        mimeType: "text/html",
        filename: "",
        headers: [h("Content-Type", 'text/html; charset="UTF-8"')],
        body: { size: 20, data: b64("<p>HTML VERSION</p>") },
      },
    ],
  },
};

export const htmlOnly: GmailMessage = {
  id: "m-html",
  threadId: "t-html",
  labelIds: ["INBOX", "CATEGORY_UPDATES"],
  snippet: "Term 4 Newsletter",
  internalDate: ms("2026-10-13T02:00:00Z"),
  payload: {
    partId: "",
    mimeType: "text/html",
    filename: "",
    headers: [
      h("From", "School Newsletter <news@school.edu.sg>"),
      h("To", "students@school.edu.sg"),
      h("Subject", "Term 4 Newsletter"),
      h("Date", "Tue, 13 Oct 2026 10:00:00 +0800"),
      h("Content-Type", "text/html; charset=utf-8"),
    ],
    body: {
      size: 300,
      data: b64(
        '<html><head><style>p{color:red}</style></head><body><h1>Term 4 Newsletter</h1>' +
          '<p>Sports day is on <b>Fri 24 Oct</b>. <a href="https://school.edu.sg/sd?token=abc123">Details</a></p>' +
          '<img src="https://cdn.example.com/banner.png" alt="banner">' +
          "<table><tr><td>Venue</td><td>School hall</td></tr></table></body></html>",
      ),
    },
  },
};

export const nestedWithAttachment: GmailMessage = {
  id: "m-nested",
  threadId: "t-nested",
  labelIds: ["INBOX"],
  snippet: "",
  internalDate: ms("2026-10-14T03:00:00Z"),
  payload: {
    partId: "",
    mimeType: "multipart/mixed",
    filename: "",
    headers: [...STD_HEADERS, h("Content-Type", 'multipart/mixed; boundary="m"')],
    body: { size: 0 },
    parts: [
      {
        partId: "0",
        mimeType: "multipart/related",
        filename: "",
        headers: [h("Content-Type", 'multipart/related; boundary="r"')],
        body: { size: 0 },
        parts: [
          {
            partId: "0.0",
            mimeType: "multipart/alternative",
            filename: "",
            headers: [],
            body: { size: 0 },
            parts: [
              {
                partId: "0.0.0",
                mimeType: "text/plain",
                filename: "",
                headers: [h("Content-Type", 'text/plain; charset="ISO-8859-1"')],
                body: { size: 19, data: b64("Café menu attached.", "latin1") },
              },
              {
                partId: "0.0.1",
                mimeType: "text/html",
                filename: "",
                headers: [h("Content-Type", "text/html; charset=ISO-8859-1")],
                body: { size: 33, data: b64("<p>Caf&eacute; menu attached.</p>", "latin1") },
              },
            ],
          },
          {
            partId: "0.1",
            mimeType: "image/png",
            filename: "logo.png",
            headers: [h("Content-Disposition", 'inline; filename="logo.png"'), h("Content-ID", "<logo>")],
            body: { attachmentId: "ANGjdJ_logo", size: 2048 },
          },
        ],
      },
      {
        partId: "1",
        mimeType: "application/pdf",
        filename: "Consent Form.pdf",
        headers: [h("Content-Disposition", 'attachment; filename="Consent Form.pdf"')],
        body: { attachmentId: "ANGjdJ_pdf", size: 52344 },
      },
    ],
  },
};

export const missingHeaders: GmailMessage = {
  id: "m-bare",
  threadId: "t-bare",
  labelIds: ["INBOX"],
  payload: { mimeType: "text/plain", filename: "", body: { size: 5, data: b64("hello") } },
};

export const garbageDate: GmailMessage = {
  id: "m-garbage",
  threadId: "t-garbage",
  labelIds: ["INBOX"],
  payload: {
    mimeType: "text/plain",
    headers: [h("From", "a@b.com"), h("Date", "sometime next week lol")],
    body: { size: 1, data: b64("x") },
  },
};

export const headerDateOnly: GmailMessage = {
  id: "m-hdr",
  threadId: "t-hdr",
  labelIds: ["INBOX"],
  payload: {
    mimeType: "text/plain",
    headers: [h("From", "a@b.com"), h("Date", "Wed, 14 Oct 2026 23:50:00 +0800")],
    body: { size: 1, data: b64("x") },
  },
};

export const imageOnly: GmailMessage = {
  id: "m-img",
  threadId: "t-img",
  labelIds: ["INBOX"],
  internalDate: ms("2026-10-14T04:00:00Z"),
  payload: {
    mimeType: "multipart/related",
    filename: "",
    headers: [h("From", "CCA Exco <exco@school.edu.sg>"), h("Subject", "Poster")],
    body: { size: 0 },
    parts: [
      {
        partId: "0",
        mimeType: "text/html",
        filename: "",
        headers: [h("Content-Type", "text/html; charset=UTF-8")],
        body: { size: 33, data: b64('<div><img src="cid:poster"></div>') },
      },
      {
        partId: "1",
        mimeType: "image/jpeg",
        filename: "poster.jpg",
        headers: [h("Content-Disposition", 'inline; filename="poster.jpg"')],
        body: { attachmentId: "att", size: 300000 },
      },
    ],
  },
};

export const metadataOnly: GmailMessage = {
  id: "m-meta",
  threadId: "t-meta",
  labelIds: ["INBOX"],
  snippet: "Don&#39;t forget &amp; bring your &quot;PE kit&quot;",
  internalDate: ms("2026-10-14T05:00:00Z"),
  payload: {
    mimeType: "multipart/alternative",
    headers: [h("From", "Ms Lee <lee@school.edu.sg>"), h("Subject", "PE tomorrow"), h("Date", "Wed, 14 Oct 2026 13:00:00 +0800")],
  },
};
