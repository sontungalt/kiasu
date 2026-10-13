import { describe, it, expect } from "vitest";
import { FakeGmailApi, buildMessage } from "../helpers/fake-gmail.js";

describe("FakeGmailApi", () => {
  it("reports history after a start id and 404s when stale", async () => {
    const api = new FakeGmailApi();
    api.addMessage(buildMessage({ id: "a" }));
    api.addMessage(buildMessage({ id: "b" }));
    expect(await api.listHistory("100")).toEqual({
      added: [{ id: "a", threadId: "t-a" }, { id: "b", threadId: "t-b" }],
      historyId: "102",
    });
    expect((await api.listHistory("101")).added.map((r) => r.id)).toEqual(["b"]);
    api.staleHistory = true;
    await expect(api.listHistory("100")).rejects.toMatchObject({ status: 404 });
  });

  it("revokes after N successful getMessage calls", async () => {
    const api = new FakeGmailApi();
    api.addMessage(buildMessage({ id: "a" }));
    api.addMessage(buildMessage({ id: "b" }));
    api.getsBeforeRevoke = 1;
    await expect(api.getMessage("a", "full")).resolves.toMatchObject({ id: "a" });
    await expect(api.getMessage("b", "full")).rejects.toThrow("invalid_grant");
    await expect(api.getProfile()).rejects.toThrow("invalid_grant");
  });
});
