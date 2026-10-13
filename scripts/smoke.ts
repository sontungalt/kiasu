/**
 * Manual end-to-end checks (see docs/e2e-checklist.md).
 *   health        GET  <url>/healthz
 *   whatsapp      send a test text to MY_WHATSAPP_NUMBER via the Graph API client
 *   tick          POST <url>/jobs/tick  (local: optional --now=<ISO>; prod: use gcloud scheduler jobs run)
 *   close-window  emulator only: set state/whatsapp.lastInboundAt to 2 days ago so the template path runs
 *   all           health + whatsapp + tick (local)
 */
import { loadConfig } from "../src/config.js";
import { formatSgt } from "../src/lib/clock.js";
import { createFirestore, FirestoreStore } from "../src/store/firestore.js";
import { createWhatsAppClient } from "../src/whatsapp/client.js";
import { ALL_SECRET_KEYS, fillFromSecretManager, projectFromEnv } from "./lib/secrets.js";
import { daysBefore, parseSmokeArgs, tickUrl } from "./lib/smoke.js";

async function health(url: string): Promise<boolean> {
  const res = await fetch(`${url}/healthz`);
  const body = await res.text();
  console.log(`${res.ok ? "✅" : "❌"} healthz ${res.status} ${body}`);
  return res.ok;
}

async function whatsapp(): Promise<boolean> {
  await fillFromSecretManager(process.env, ALL_SECRET_KEYS, projectFromEnv(process.env));
  const config = loadConfig();
  const { messageId } = await createWhatsAppClient(config).sendText(
    `✅ kiasu-assistant smoke test, ${formatSgt(new Date(), "dayDateTime")}`);
  console.log(`✅ WhatsApp accepted the text (id ${messageId}).`);
  console.log("   Nothing on your phone? Free text needs the 24h window open: send the bot any message first.");
  return true;
}

async function tick(url: string, now: string | null): Promise<boolean> {
  const target = tickUrl(url, now);
  const res = await fetch(target, { method: "POST" });
  console.log(`${res.ok ? "✅" : "❌"} tick ${res.status} ${(await res.text()).slice(0, 300)}`);
  if (res.status === 401) console.log("   401: the server is checking OIDC. Run it with DEV_SKIP_OIDC=true locally.");
  return res.ok;
}

async function closeWindow(): Promise<boolean> {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.error("close-window only runs against the Firestore emulator (set FIRESTORE_EMULATOR_HOST).");
    return false;
  }
  const project = process.env.GCP_PROJECT ?? "demo-inbox";
  const lastInboundAt = daysBefore(new Date(), 2);
  await new FirestoreStore(createFirestore(project)).state.set("whatsapp", { lastInboundAt });
  console.log(`✅ state/whatsapp.lastInboundAt = ${lastInboundAt} (window closed). The next outbound message uses a template.`);
  return true;
}

async function main(): Promise<number> {
  const args = parseSmokeArgs(process.argv.slice(2), process.env);
  const results: boolean[] = [];
  if (args.command === "health" || args.command === "all") results.push(await health(args.url));
  if (args.command === "whatsapp" || args.command === "all") results.push(await whatsapp());
  if (args.command === "tick" || args.command === "all") results.push(await tick(args.url, args.now));
  if (args.command === "close-window") results.push(await closeWindow());
  return results.every(Boolean) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
