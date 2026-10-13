import { describe, it, expect, vi } from "vitest";
import type { CloudTasksClient } from "@google-cloud/tasks";
import { createCloudTaskQueue, createInlineTaskQueue, taskIdFor } from "../../src/whatsapp/tasks.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/log.js";
import type { InboundMessage } from "../../src/types.js";
import { TEST_ENV } from "../helpers/env.js";

const config = loadConfig(TEST_ENV);
const MSG: InboundMessage = {
  id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
  from: "6500000000", timestamp: "2026-10-14T00:00:00.000Z", type: "text", text: "done 2", contextMessageId: null,
};

interface CreateTaskArg {
  parent: string;
  task: {
    name: string;
    httpRequest: { httpMethod: string; url: string; headers: Record<string, string>; body: string;
      oidcToken: { serviceAccountEmail: string; audience: string } };
  };
}

function fakeTasksClient(impl: (req: CreateTaskArg) => Promise<unknown> = async () => [{}]) {
  const createTask = vi.fn(impl);
  return { createTask, client: { createTask } as unknown as Pick<CloudTasksClient, "createTask"> };
}

describe("createCloudTaskQueue", () => {
  it("creates an OIDC-authenticated HTTP task for /tasks/handle-message", async () => {
    const fake = fakeTasksClient();
    await createCloudTaskQueue(config, fake.client).enqueueInbound(MSG);
    expect(fake.createTask).toHaveBeenCalledTimes(1);
    const req = fake.createTask.mock.calls[0]![0];
    expect(req.parent).toBe(config.TASKS_QUEUE);
    expect(req.task.name).toBe(`${config.TASKS_QUEUE}/tasks/${taskIdFor(MSG.id)}`);
    expect(req.task.httpRequest).toMatchObject({
      httpMethod: "POST",
      url: "https://bot.example.com/tasks/handle-message",
      headers: { "Content-Type": "application/json" },
      oidcToken: { serviceAccountEmail: config.INVOKER_SERVICE_ACCOUNT, audience: "https://bot.example.com/tasks/handle-message" },
    });
    expect(JSON.parse(Buffer.from(req.task.httpRequest.body, "base64").toString("utf8"))).toEqual(MSG);
  });

  it("derives a valid, stable, per-message task id", () => {
    const id = taskIdFor(MSG.id);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
    expect(taskIdFor(MSG.id)).toBe(id);
    expect(taskIdFor("wamid.other")).not.toBe(id);
  });

  it("treats ALREADY_EXISTS as success and rethrows other errors", async () => {
    const exists = fakeTasksClient(async () => { throw Object.assign(new Error("6 ALREADY_EXISTS: Requested entity already exists"), { code: 6 }); });
    await expect(createCloudTaskQueue(config, exists.client).enqueueInbound(MSG)).resolves.toBeUndefined();
    const down = fakeTasksClient(async () => { throw Object.assign(new Error("14 UNAVAILABLE"), { code: 14 }); });
    await expect(createCloudTaskQueue(config, down.client).enqueueInbound(MSG)).rejects.toThrow("UNAVAILABLE");
  });
});

describe("createInlineTaskQueue", () => {
  it("returns before the handler finishes, then runs it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handled: string[] = [];
    const queue = createInlineTaskQueue(async (m) => { await gate; handled.push(m.id); });
    await queue.enqueueInbound(MSG);
    expect(handled).toEqual([]);
    release();
    await vi.waitFor(() => expect(handled).toEqual([MSG.id]));
  });

  it("logs handler errors instead of throwing", async () => {
    const lines: string[] = [];
    const queue = createInlineTaskQueue(async () => { throw new Error("agent blew up"); }, createLogger({}, (l) => lines.push(l)));
    await expect(queue.enqueueInbound(MSG)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(JSON.parse(lines[0]!)).toMatchObject({ severity: "ERROR", message: "inline task failed", messageId: MSG.id });
  });
});
