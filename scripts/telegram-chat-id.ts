/**
 * Prints the chat id, first name and text of the bot's recent messages, so you can set TELEGRAM_CHAT_ID.
 * Usage: send your bot a message in Telegram, then `npm run telegram:chat-id`. Reads TELEGRAM_BOT_TOKEN from .env.
 */
import { callBotApi, chatIdReport, type TgUpdate } from "./lib/telegram.js";

async function main(): Promise<number> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN isn't set in .env (BotFather gives it to you after /newbot).");
    return 1;
  }
  const res = await callBotApi<TgUpdate[]>(token, "getUpdates", { offset: -20, timeout: 0 });
  for (const line of chatIdReport(res)) console.log(line);
  return res.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
