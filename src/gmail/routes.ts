import { z } from "zod";
import type { RouteRegistrar } from "../server.js";
import { oidcPreHandler } from "../http/oidc.js";
import { errInfo } from "./api.js";

const PushEnvelope = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().optional(),
    message_id: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

const GmailNotification = z.object({
  emailAddress: z.string().min(3),
  historyId: z.union([z.string(), z.number()]).transform((v) => String(v)),
});

export interface DecodedPush {
  messageId: string | null;
  notification: { emailAddress: string; historyId: string };
}

export function decodePush(body: unknown): DecodedPush | null {
  const env = PushEnvelope.safeParse(body);
  if (!env.success) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(env.data.message.data, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const note = GmailNotification.safeParse(json);
  if (!note.success) return null;
  return {
    messageId: env.data.message.messageId ?? env.data.message.message_id ?? null,
    notification: note.data,
  };
}

/** POST /webhooks/gmail: Pub/Sub push from users.watch. Always 204 once authenticated. */
export const registerGmailRoutes: RouteRegistrar = (app, deps) => {
  app.post("/webhooks/gmail", { preHandler: oidcPreHandler(deps) }, async (request, reply) => {
    const push = decodePush(request.body);
    if (!push) {
      deps.log.warn("gmail push ignored: malformed body");
      return reply.code(204).send();
    }
    if (push.messageId) {
      const first = await deps.store.processed.claim(`ps:${push.messageId}`, deps.clock.now().toISOString());
      if (!first) {
        deps.log.info("gmail push duplicate", { messageId: push.messageId });
        return reply.code(204).send();
      }
    }
    try {
      const result = await deps.mail.handlePush(push.notification);
      if (result.alerts.length > 0) await deps.notifier.sendAlerts(result.alerts);
      deps.log.info("gmail push handled", {
        messageId: push.messageId, fetched: result.fetched, triaged: result.triaged, alerts: result.alerts.length,
      });
    } catch (err) {
      deps.log.error("gmail push failed", { messageId: push.messageId, err: errInfo(err) });
    }
    return reply.code(204).send();
  });
};
