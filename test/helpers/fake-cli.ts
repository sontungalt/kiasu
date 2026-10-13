import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Fake `gcloud`, `curl` and `npm` on PATH. Each one logs its argv to $FAKE_DIR/log, one line per call.
 * Env vars that control the fake gcloud:
 *   FAKE_EXISTS=true          every other `... describe` succeeds (the resource exists)
 *   FAKE_SECRETS="A B"        secrets that have an enabled version
 *   FAKE_URL=https://...      what `run services describe` prints once deployed
 *   FAKE_SERVICE_EXISTS=true  the Cloud Run service exists before the deploy
 */
const GCLOUD = `#!/usr/bin/env bash
echo "gcloud $*" >> "$FAKE_DIR/log"
case "$*" in
  "projects describe"*) echo "123456789"; exit 0 ;;
  "auth print-access-token"*) echo "fake-access-token"; exit 0 ;;
  "secrets versions add"*) echo "stdin: $(cat)" >> "$FAKE_DIR/log"; exit 0 ;;
  "secrets versions list "*)
    name="$(echo "$*" | awk '{print $4}')"
    for s in \${FAKE_SECRETS:-}; do [[ "$s" == "$name" ]] && echo "projects/x/secrets/$s/versions/1"; done
    exit 0 ;;
  "run deploy"*)
    for a in "$@"; do case "$a" in --env-vars-file=*) cp "\${a#--env-vars-file=}" "$FAKE_DIR/env.yaml" ;; esac; done
    touch "$FAKE_DIR/deployed"; exit 0 ;;
  "run services describe"*)
    if [[ -f "$FAKE_DIR/deployed" || "\${FAKE_SERVICE_EXISTS:-false}" == "true" ]]; then echo "$FAKE_URL"; exit 0; fi
    exit 1 ;;
  *" describe"*) [[ "\${FAKE_EXISTS:-false}" == "true" ]] && exit 0; exit 1 ;;
esac
exit 0
`;

const LOGGER = (name: string) => `#!/usr/bin/env bash
echo "${name} $*" >> "$FAKE_DIR/log"
[[ -t 0 ]] || echo "${name}-stdin: $(cat)" >> "$FAKE_DIR/log"
exit 0
`;

export interface FakeRun {
  status: number | null;
  stdout: string;
  stderr: string;
  log: string[];
  dir: string;
}

export function runWithFakeCli(script: string, args: string[], env: Record<string, string>, input?: string): FakeRun {
  const dir = mkdtempSync(join(tmpdir(), "fake-cli-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, body] of [["gcloud", GCLOUD], ["curl", LOGGER("curl")], ["npm", LOGGER("npm")]] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const res = spawnSync("bash", [script, ...args], {
    cwd: process.cwd(),
    input: input ?? "",
    encoding: "utf8",
    // ENV_FILE defaults to a missing file so the real .env (with real values) is never read by tests.
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, ENV_FILE: join(dir, "none.env"), ...env },
  });
  const logFile = join(dir, "log");
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n") : [];
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, log, dir };
}
