import { toUtcIso } from "../../src/lib/clock.js";

export type SmokeCommand = "health" | "whatsapp" | "tick" | "close-window" | "all";
const COMMANDS: readonly SmokeCommand[] = ["health", "whatsapp", "tick", "close-window", "all"];

export const SMOKE_USAGE =
  "Usage: npm run smoke -- health|whatsapp|tick|close-window|all [--url=http://localhost:8080] [--now=<ISO time>]";

export interface SmokeArgs {
  command: SmokeCommand;
  url: string;
  now: string | null;
}

const flag = (argv: string[], name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

export function parseSmokeArgs(argv: string[], env: Record<string, string | undefined>): SmokeArgs {
  const command = argv.find((a) => !a.startsWith("--")) as SmokeCommand | undefined;
  if (!command || !COMMANDS.includes(command)) throw new Error(SMOKE_USAGE);
  const url = (flag(argv, "url") ?? env.SMOKE_URL ?? "http://localhost:8080").replace(/\/+$/, "");
  return { command, url, now: flag(argv, "now") };
}

export function isLocalUrl(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** ?now only works when the server runs with DEV_SKIP_OIDC=true, i.e. locally. */
export function tickUrl(base: string, now: string | null): string {
  if (now === null) return `${base}/jobs/tick`;
  if (!isLocalUrl(base)) {
    throw new Error("--now only works against a local server. In production, run: gcloud scheduler jobs run tick --location=asia-southeast1");
  }
  return `${base}/jobs/tick?now=${encodeURIComponent(toUtcIso(now))}`;
}

export function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}
