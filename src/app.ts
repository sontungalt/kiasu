import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { systemClock } from "./lib/clock.js";
import { createLogger } from "./lib/log.js";
import type { Deps } from "./ports.js";
import { buildServer, type RouteRegistrar } from "./server.js";
import { MemoryStore } from "./store/memory.js";
import { FirestoreStore, createFirestore } from "./store/firestore.js";
import type { Store } from "./store/types.js";
import type { InboundMessage } from "./types.js";
import { createMailService } from "./gmail/sync.js";
import { registerGmailRoutes } from "./gmail/routes.js";
import { createCalendarService } from "./calendar/service.js";
import { createClassroomService } from "./classroom/service.js";
import { createWhatsAppClient } from "./whatsapp/client.js";
import { createOutbox } from "./whatsapp/outbox.js";
import { createCloudTaskQueue, createInlineTaskQueue } from "./whatsapp/tasks.js";
import { registerWhatsAppRoutes } from "./whatsapp/webhook.js";
import { createNotifier } from "./notify/notifier.js";
import { registerJobRoutes } from "./scheduler/routes.js";
import { createChatAgent } from "./agent/agent.js";
import { registerTaskRoutes } from "./agent/routes.js";

export const REGISTRARS: RouteRegistrar[] = [registerGmailRoutes, registerWhatsAppRoutes, registerJobRoutes, registerTaskRoutes];

export type StoreKind = "firestore" | "memory";

/** STORE is read straight from the environment (not part of Config). Production always uses Firestore. */
export function chooseStoreKind(config: Pick<Config, "NODE_ENV">, env: Record<string, string | undefined>): StoreKind {
  const raw = (env.STORE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "firestore") return "firestore";
  if (raw === "memory") {
    if (config.NODE_ENV === "production") {
      throw new Error("STORE=memory is not allowed in production (all data would be lost on every restart)");
    }
    return "memory";
  }
  throw new Error(`STORE must be "firestore" or "memory", got "${env.STORE}"`);
}

export interface BuildOptions {
  env?: Record<string, string | undefined>;
  /** Replace any built dependency (tests, scripts). */
  overrides?: Partial<Omit<Deps, "config">>;
}

export function buildDeps(config: Config, opts: BuildOptions = {}): { deps: Deps; bindApp(app: FastifyInstance): void } {
  const env = opts.env ?? process.env;
  const o = opts.overrides ?? {};

  const clock = o.clock ?? systemClock;
  const log = o.log ?? createLogger({ service: "kiasu-assistant" });
  let store: Store;
  if (o.store) {
    store = o.store;
  } else {
    const kind = chooseStoreKind(config, env);
    store = kind === "memory" ? new MemoryStore() : new FirestoreStore(createFirestore(config.GCP_PROJECT));
    log.info("store selected", { kind });
  }
  const anthropic = o.anthropic ?? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const whatsapp = o.whatsapp ?? createWhatsAppClient(config);
  const outbox = o.outbox ?? createOutbox({ clock, log, store, whatsapp });
  const notifier = o.notifier ?? createNotifier({ clock, log, store, outbox });
  const mail = o.mail ?? createMailService({ config, clock, log, store, anthropic, outbox });
  const calendar = o.calendar ?? createCalendarService({ config, log, store });
  const classroom = o.classroom ?? createClassroomService({ config, clock, log, store, anthropic });
  const agent = o.agent ?? createChatAgent({ config, clock, log, store, anthropic, mail, calendar });

  let app: FastifyInstance | null = null;
  const tasks =
    o.tasks ??
    (config.DEV_SKIP_OIDC
      ? createInlineTaskQueue(async (msg: InboundMessage) => {
          if (!app) throw new Error("inline task queue used before the app was built");
          const res = await app.inject({ method: "POST", url: "/tasks/handle-message", payload: { ...msg } });
          if (res.statusCode >= 400) log.error("inline task failed", { status: res.statusCode, messageId: msg.id });
        }, log)
      : createCloudTaskQueue(config));

  const deps: Deps = { config, clock, log, store, anthropic, mail, calendar, classroom, whatsapp, outbox, tasks, notifier, agent };
  return {
    deps,
    bindApp: (a) => {
      app = a;
    },
  };
}

export async function buildApp(config: Config, opts: BuildOptions = {}): Promise<{ app: FastifyInstance; deps: Deps }> {
  const { deps, bindApp } = buildDeps(config, opts);
  const app = await buildServer(deps, REGISTRARS);
  bindApp(app);
  return { app, deps };
}
