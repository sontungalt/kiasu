import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createGmailApiFactory } from "../src/gmail/api.js";
import { parseGmailMessage } from "../src/gmail/parse.js";
import type { AccountId } from "../src/types.js";
import { redactParsed } from "../evals/triage/redact.js";
import type { Labels } from "../evals/triage/score.js";

const DEFAULT_QUERY = "in:inbox newer_than:30d -category:promotions -category:social";
const [accountArg, query = DEFAULT_QUERY, maxArg = "15"] = process.argv.slice(2);
if (accountArg !== "personal" && accountArg !== "school") {
  console.error('Usage: npm run export:fixtures -- <personal|school> ["gmail query"] [max]');
  process.exit(2);
}
const account: AccountId = accountArg;
const api = createGmailApiFactory(loadConfig())(account);
if (!api) {
  console.error(`No refresh token for ${account}. Run: npm run auth -- ${account}`);
  process.exit(2);
}

const root = path.resolve("evals/triage");
const fixturesDir = path.join(root, "fixtures");
const labelsPath = path.join(root, "labels.json");
await mkdir(fixturesDir, { recursive: true });
const labels: Labels = await readFile(labelsPath, "utf8")
  .then((s) => JSON.parse(s) as Labels)
  .catch(() => ({}));

for (const ref of await api.listMessages(query, Number(maxArg))) {
  const parsed = redactParsed(parseGmailMessage(await api.getMessage(ref.id, "full"), account));
  const id = `${account}-${ref.id}`;
  await writeFile(path.join(fixturesDir, `${id}.json`), `${JSON.stringify({ id, parsed }, null, 2)}\n`);
  labels[id] ??= { labelled: false, category: null, importance: null, expectUrgent: false, deadlines: [], notes: parsed.subject };
  console.log(`${id}  ${parsed.subject}`);
}
await writeFile(labelsPath, `${JSON.stringify(labels, null, 2)}\n`);
console.log(`\nWrote fixtures to ${fixturesDir}. Now redact by hand and label them in ${labelsPath}.`);
