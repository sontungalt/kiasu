import { createHash } from "node:crypto";
import { CloudTasksClient } from "@google-cloud/tasks";
import type { Config } from "../config.js";
import { silentLogger, type Logger } from "../lib/log.js";
import type { TaskQueue } from "../ports.js";
import type { InboundMessage } from "../types.js";

/** Route served by plan 05; the OIDC audience must equal PUBLIC_BASE_URL + this path. */
export const HANDLE_MESSAGE_PATH = "/tasks/handle-message";

const GRPC_ALREADY_EXISTS = 6;

/**
 * Task ids allow only [A-Za-z0-9_-] (max 500). A sha256 hex of the WhatsApp message id is valid,
 * stable per message (so a re-enqueue dedupes), and non-sequential, which Google recommends.
 */
export function taskIdFor(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex");
}

export function createCloudTaskQueue(config: Config, client?: Pick<CloudTasksClient, "createTask">): TaskQueue {
  const { TASKS_QUEUE: queue, INVOKER_SERVICE_ACCOUNT: invoker } = config;
  if (!queue || !invoker) throw new Error("Cloud Tasks needs TASKS_QUEUE and INVOKER_SERVICE_ACCOUNT");
  const url = `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}${HANDLE_MESSAGE_PATH}`;
  let tasks = client;
  return {
    async enqueueInbound(msg: InboundMessage): Promise<void> {
      tasks ??= new CloudTasksClient();
      try {
        await tasks.createTask({
          parent: queue,
          task: {
            name: `${queue}/tasks/${taskIdFor(msg.id)}`,
            httpRequest: {
              httpMethod: "POST",
              url,
              headers: { "Content-Type": "application/json" },
              body: Buffer.from(JSON.stringify(msg)).toString("base64"),
              oidcToken: { serviceAccountEmail: invoker, audience: url },
            },
          },
        });
      } catch (err) {
        // Same message enqueued before (Meta retry, or a duplicate that slipped past the claim): fine.
        if ((err as { code?: unknown }).code === GRPC_ALREADY_EXISTS) return;
        throw err;
      }
    },
  };
}

/** Local dev: runs the handler in the background so the webhook can still answer immediately. */
export function createInlineTaskQueue(
  handle: (msg: InboundMessage) => Promise<void>,
  log: Logger = silentLogger,
): TaskQueue {
  return {
    async enqueueInbound(msg: InboundMessage): Promise<void> {
      setImmediate(() => {
        Promise.resolve()
          .then(() => handle(msg))
          .catch((err: unknown) => log.error("inline task failed", { messageId: msg.id, err }));
      });
    },
  };
}
