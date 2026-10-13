import { describe, it, expect } from "vitest";
import { createLogger } from "../../src/lib/log.js";

describe("logger", () => {
  it("writes one JSON line with severity and fields", () => {
    const lines: string[] = [];
    const log = createLogger({ service: "test" }, (l) => lines.push(l));
    log.warn("hello", { emailId: "m1" });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ severity: "WARNING", message: "hello", service: "test", emailId: "m1" });
  });

  it("serialises errors", () => {
    const lines: string[] = [];
    const log = createLogger({}, (l) => lines.push(l));
    log.error("boom", { err: new Error("bad") });
    expect(JSON.parse(lines[0]!).err).toMatchObject({ message: "bad" });
  });
});
