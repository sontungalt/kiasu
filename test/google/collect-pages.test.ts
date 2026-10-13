import { describe, it, expect } from "vitest";
import { collectPages } from "../../src/google/collect-pages.js";

describe("collectPages", () => {
  it("follows nextPageToken until it is empty", async () => {
    const tokens: Array<string | undefined> = [];
    const pages: Record<string, { items: number[]; nextPageToken: string | null }> = {
      start: { items: [1, 2], nextPageToken: "b" },
      b: { items: [3], nextPageToken: "c" },
      c: { items: [4], nextPageToken: "" },
    };
    const out = await collectPages(async (t) => {
      tokens.push(t);
      return pages[t ?? "start"]!;
    });
    expect(out).toEqual([1, 2, 3, 4]);
    expect(tokens).toEqual([undefined, "b", "c"]);
  });

  it("stops when the API repeats a token", async () => {
    let calls = 0;
    const out = await collectPages(async () => {
      calls++;
      return { items: [calls], nextPageToken: "same" };
    });
    expect(out).toEqual([1, 2]);
    expect(calls).toBe(2);
  });

  it("stops at maxPages", async () => {
    let n = 0;
    const out = await collectPages(async () => ({ items: [n], nextPageToken: `t${++n}` }), { maxPages: 3 });
    expect(out).toHaveLength(3);
  });

  it("stopAfter ends paging early", async () => {
    let calls = 0;
    const out = await collectPages(
      async () => {
        calls++;
        return { items: [calls], nextPageToken: `t${calls}` };
      },
      { stopAfter: (items) => items.includes(2) },
    );
    expect(out).toEqual([1, 2]);
    expect(calls).toBe(2);
  });
});
