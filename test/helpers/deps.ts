import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../../src/config.js";
import { FakeClock } from "../../src/lib/clock.js";
import { silentLogger } from "../../src/lib/log.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { Deps } from "../../src/ports.js";
import { TEST_ENV } from "./env.js";

/** Returns an object whose every method rejects with "<name>.<method> not stubbed". */
function stub<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_t, prop) => async () => {
      throw new Error(`${name}.${String(prop)} not stubbed`);
    },
  });
}

export type TestDeps = Deps & { store: MemoryStore; clock: FakeClock };

export function makeTestDeps(over: Partial<Deps> = {}): TestDeps {
  const base: TestDeps = {
    config: loadConfig(TEST_ENV),
    clock: new FakeClock("2026-10-14T00:00:00Z"),
    log: silentLogger,
    store: new MemoryStore(),
    anthropic: new Anthropic({ apiKey: "test-key", maxRetries: 0 }),
    mail: stub("mail"),
    calendar: stub("calendar"),
    classroom: stub("classroom"),
    whatsapp: stub("whatsapp"),
    outbox: stub("outbox"),
    tasks: stub("tasks"),
    notifier: stub("notifier"),
    agent: stub("agent"),
  };
  return { ...base, ...over } as TestDeps;
}
