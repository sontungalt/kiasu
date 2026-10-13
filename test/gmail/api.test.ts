import { describe, it, expect } from "vitest";
import type { gmail_v1 } from "googleapis";
import { gmailApiFromClient, createGmailApiFactory, httpStatusOf, errInfo } from "../../src/gmail/api.js";
import { loadConfig } from "../../src/config.js";
import { TEST_ENV } from "../helpers/env.js";

type Call = [string, Record<string, any>];

function fakeClient(historyPages: Record<string, unknown> = {}, messagePages: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const rec = (name: string, data: (p: Record<string, any>) => unknown) => async (p: Record<string, any>) => {
    calls.push([name, p]);
    return { data: data(p) };
  };
  const client = {
    users: {
      getProfile: rec("getProfile", () => ({ emailAddress: "Me@Example.com", historyId: "500" })),
      watch: rec("watch", () => ({ historyId: "600", expiration: "1761004800000" })),
      history: { list: rec("history.list", (p) => historyPages[p.pageToken ?? "first"]) },
      messages: {
        list: rec("messages.list", (p) => messagePages[p.pageToken ?? "first"]),
        get: rec("messages.get", (p) => ({ id: p.id, threadId: "t" })),
      },
    },
  };
  return { gmail: gmailApiFromClient(client as unknown as gmail_v1.Gmail), calls };
}

describe("gmailApiFromClient", () => {
  it("listHistory pages through messageAdded INBOX history and dedupes ids", async () => {
    const { gmail, calls } = fakeClient({
      first: {
        history: [
          { id: "101", messagesAdded: [{ message: { id: "a", threadId: "ta" } }] },
          { id: "102", messagesAdded: [{ message: { id: "b", threadId: "tb" } }, { message: { id: "a", threadId: "ta" } }] },
        ],
        nextPageToken: "p2",
        historyId: "110",
      },
      p2: { history: [{ id: "111", messagesAdded: [{ message: { id: "c", threadId: "tc" } }] }], historyId: "112" },
    });
    const res = await gmail.listHistory("100");
    expect(res).toEqual({
      added: [{ id: "a", threadId: "ta" }, { id: "b", threadId: "tb" }, { id: "c", threadId: "tc" }],
      historyId: "112",
    });
    expect(calls[0]![1]).toMatchObject({ userId: "me", startHistoryId: "100", historyTypes: ["messageAdded"], labelId: "INBOX" });
    expect(calls[1]![1]).toMatchObject({ pageToken: "p2" });
  });

  it("listHistory with no history keeps the response historyId", async () => {
    const { gmail } = fakeClient({ first: { historyId: "120" } });
    expect(await gmail.listHistory("100")).toEqual({ added: [], historyId: "120" });
  });

  it("watch asks for INBOX only with labelFilterBehavior include", async () => {
    const { gmail, calls } = fakeClient();
    expect(await gmail.watch("projects/p/topics/t")).toEqual({ historyId: "600", expiration: "1761004800000" });
    expect(calls[0]).toEqual(["watch", {
      userId: "me",
      requestBody: { topicName: "projects/p/topics/t", labelIds: ["INBOX"], labelFilterBehavior: "include" },
    }]);
  });

  it("getMessage passes format, and metadataHeaders only for metadata", async () => {
    const { gmail, calls } = fakeClient();
    await gmail.getMessage("m1", "metadata");
    await gmail.getMessage("m2", "full");
    expect(calls[0]![1]).toEqual({ userId: "me", id: "m1", format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] });
    expect(calls[1]![1]).toEqual({ userId: "me", id: "m2", format: "full" });
  });

  it("listMessages pages until maxResults", async () => {
    const pages = {
      first: { messages: [{ id: "1", threadId: "t1" }, { id: "2", threadId: "t2" }], nextPageToken: "n" },
      n: { messages: [{ id: "3", threadId: "t3" }] },
    };
    const three = fakeClient({}, pages);
    expect((await three.gmail.listMessages("in:inbox", 3)).map((m) => m.id)).toEqual(["1", "2", "3"]);
    expect(three.calls[0]![1]).toMatchObject({ userId: "me", q: "in:inbox", maxResults: 3 });
    expect(three.calls[1]![1]).toMatchObject({ pageToken: "n", maxResults: 1 });
    const two = fakeClient({}, pages);
    expect((await two.gmail.listMessages("in:inbox", 2)).map((m) => m.id)).toEqual(["1", "2"]);
    expect(two.calls).toHaveLength(1);
  });

  it("getProfile returns the address and historyId", async () => {
    const { gmail } = fakeClient();
    expect(await gmail.getProfile()).toEqual({ emailAddress: "Me@Example.com", historyId: "500" });
  });
});

describe("error helpers", () => {
  it("httpStatusOf reads gaxios-style errors", () => {
    expect(httpStatusOf({ status: 404 })).toBe(404);
    expect(httpStatusOf({ response: { status: 410 } })).toBe(410);
    expect(httpStatusOf({ code: "404" })).toBe(404);
    expect(httpStatusOf({ code: "ECONNRESET" })).toBeNull();
    expect(httpStatusOf(null)).toBeNull();
  });

  it("errInfo keeps name and status and caps the message", () => {
    const info = errInfo(Object.assign(new Error("x".repeat(500)), { status: 503 }));
    expect(info).toMatchObject({ name: "Error", status: 503 });
    expect(info.message).toHaveLength(200);
  });
});

describe("createGmailApiFactory", () => {
  it("returns null without a refresh token and caches one client per account", () => {
    const factory = createGmailApiFactory(loadConfig({ ...TEST_ENV, GOOGLE_REFRESH_TOKEN_SCHOOL: "" }));
    expect(factory("school")).toBeNull();
    const personal = factory("personal");
    expect(personal).not.toBeNull();
    expect(factory("personal")).toBe(personal);
  });
});
