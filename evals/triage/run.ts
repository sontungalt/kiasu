import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { triageEmail } from "../../src/triage/triage.js";
import type { ParsedEmail } from "../../src/types.js";
import { formatReport, scoreTriage, type EvalCase, type Labels } from "./score.js";

interface Fixture {
  id: string;
  parsed: ParsedEmail;
  now?: string; // defaults to received + 5 minutes
}

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<number> {
  const model = process.env.TRIAGE_MODEL;
  if (!process.env.ANTHROPIC_API_KEY || !model) {
    console.error("Set ANTHROPIC_API_KEY and TRIAGE_MODEL in .env");
    return 2;
  }
  const fixturesDir = path.join(here, "fixtures");
  const files = (await readdir(fixturesDir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) {
    console.error(`No fixtures in ${fixturesDir}. See evals/triage/README.md.`);
    return 2;
  }
  const labels = JSON.parse(await readFile(path.join(here, "labels.json"), "utf8")) as Labels;
  const only = process.argv[2]; // optional: only fixture ids containing this text
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

  const cases: EvalCase[] = [];
  for (const file of files) {
    const fx = JSON.parse(await readFile(path.join(fixturesDir, file), "utf8")) as Fixture;
    if (only && !fx.id.includes(only)) continue;
    const label = labels[fx.id];
    if (!label?.labelled) {
      console.warn(`skip ${fx.id}: not labelled yet`);
      continue;
    }
    const now = new Date(fx.now ?? Date.parse(fx.parsed.date) + 5 * 60_000);
    try {
      const result = await triageEmail(anthropic, model, fx.parsed, fx.parsed.account, now);
      cases.push({ id: fx.id, subject: fx.parsed.subject, label, result, error: null });
      process.stdout.write(".");
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      cases.push({ id: fx.id, subject: fx.parsed.subject, label, result: null, error });
      process.stdout.write("x");
    }
  }
  const report = scoreTriage(cases);
  console.log(`\n${formatReport(report)}`);
  return report.passed ? 0 : 1;
}

process.exitCode = await main();
