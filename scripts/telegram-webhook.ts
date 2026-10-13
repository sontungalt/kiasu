/**
 * Points the bot's webhook at the deployed server: <url>/webhooks/telegram, with TELEGRAM_WEBHOOK_SECRET.
 * Usage: npm run telegram:webhook -- https://<your-service>.onrender.com
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from .env (the secret must match the server's).
 */
import { callBotApi, parseWebhookArg, setWebhookPayload, webhookInfoReport } from "./lib/telegram.js";

async function main(): Promise<number> {
  const url = parseWebhookArg(process.argv.slice(2));
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN isn't set in .env.");
    return 1;
  }
  const set = await callBotApi(token, "setWebhook", setWebhookPayload(url, secret));
  if (!set.ok) {
    console.error(`❌ setWebhook failed: ${set.error_code ?? "?"} ${set.description ?? ""}`);
    return 1;
  }
  console.log(`✅ webhook set to ${url}`);
  for (const line of webhookInfoReport(await callBotApi(token, "getWebhookInfo"))) console.log(`   ${line}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
