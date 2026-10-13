# Kiasu Assistant: Plan 06, Infra and Deploy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Check the risky external dependencies first (Google OAuth on the school account), then build everything needed to run the service: agent instructions (`AGENTS.md`), the OAuth and access-check scripts, idempotent GCP setup, Meta/WhatsApp and local-dev runbooks, the container, the composition root (`src/app.ts` + `src/main.ts`), the deploy script, and an end-to-end checklist with a smoke script.

**Architecture:** Phase A (Tasks 1–4) only needs plan 00, so it runs in parallel with plans 01–05. Phase B (Tasks 5–7) runs last, after plans 00–05 are merged into `main`. Shell scripts are thin, idempotent wrappers around `gcloud`. They are tested by running them against a fake `gcloud` on `PATH` that logs every call. Any logic beyond "call gcloud" lives in small pure TypeScript modules under `scripts/lib/` that have vitest tests. The deploy script predicts Cloud Run's deterministic URL so the first deploy already has the right `PUBLIC_BASE_URL`. It then re-reads the real URL and fixes it if the two differ, so OIDC audiences always equal `PUBLIC_BASE_URL + path`.

**Tech Stack:** Node 24, TypeScript (ESM, NodeNext), vitest, tsx, `googleapis` / `google-auth-library`, `gcloud` CLI 584 (Cloud Run source deploy, Pub/Sub, Cloud Scheduler, Cloud Tasks, Firestore, Secret Manager), bash 3.2 (macOS), Docker multi-stage `node:24-slim`, Meta WhatsApp Cloud API.

**Spec:** `docs/superpowers/specs/2026-10-13-kiasu-design.md` (§4 routes and auth, §7a scopes, §12 setup and secrets, §13 risks, §14 cost). **Foundation:** `docs/superpowers/plans/2026-10-13-00-foundation.md`.

**Naming:** the project folder is `~/Kiasu-assistant`. The npm package and the Cloud Run service are both `kiasu-assistant`. All commands below run from the repo root (`cd ~/Kiasu-assistant`).

**Contract changes:** none. This plan only adds files and npm scripts. Notes for the integrator:
- `src/app.ts` reads an optional `STORE` env var (`firestore` by default, or `memory` for local runs) straight from `process.env`. It isn't added to `Config`, and production refuses `STORE=memory`.
- Task 1 renames the npm package to `kiasu-assistant` with `npm pkg set name=kiasu-assistant`. This is a no-op if the coordinator has already done it.
- Wiring confirmed against merged plans 02/03/05 on main: `createInlineTaskQueue(handle, log?)`, where `handle: (msg: InboundMessage) => Promise<void>` (this plan passes `log`), and `createWhatsAppClient(config, fetchImpl = fetch)`. The body of `/tasks/handle-message` is the `InboundMessage` JSON (plan 05's `InboundMessageSchema.safeParse(request.body)`). Plan 04's notifier is built before `deps` is assembled, so `deps.notifier` is set before any tick runs. Plan 01's `createMailService` signature is still as briefed (not yet merged).

**Plan set:** this is plan 06 of 07 (00–06). **Phase A = Tasks 1–4. Phase B = Tasks 5–7.**

## Global Constraints

- Region `asia-southeast1`. Scheduler time zone `Asia/Singapore`. Tick schedule `*/5 * * * *` (spec §4).
- Fixed resource names: Cloud Run service `kiasu-assistant`, Pub/Sub topic `gmail-push`, push subscription `gmail-push-sub`, Cloud Tasks queue `inbound`, scheduler job `tick`, service accounts `invoker@<project>.iam.gserviceaccount.com` (signs OIDC for Pub/Sub, Scheduler and Tasks) and `runtime@<project>.iam.gserviceaccount.com` (Cloud Run identity).
- Env var names are exactly those in plan 00's `src/config.ts` (`GMAIL_PUBSUB_TOPIC`, `INVOKER_SERVICE_ACCOUNT`, `TASKS_QUEUE`, `DEV_SKIP_OIDC`, …). Secrets are exactly spec §12: `ANTHROPIC_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN_PERSONAL`, `GOOGLE_REFRESH_TOKEN_SCHOOL`, `WA_ACCESS_TOKEN`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`.
- **OIDC audience = `PUBLIC_BASE_URL` (no trailing slash) + route path**, because that's what plan 00's `oidcPreHandler` checks.
- **Never put a secret value on a command line, in a committed file, or in a log.** Pass values to `gcloud` on stdin (`--data-file=-`). `MY_WHATSAPP_NUMBER` lives only in the gitignored `.env` and in the Cloud Run env. It never appears in committed files, including docs and tests (tests use `6500000000`).
- OAuth consent screen: External, publishing status **"In production"** (spec §12).
- Bash scripts: `#!/usr/bin/env bash`, `set -euo pipefail`, idempotent (`describe || create`), `shellcheck`-clean, and **compatible with macOS's `/bin/bash` 3.2** (no associative arrays, no `mapfile`, no `${x,,}`).
- Only `@anthropic-ai/sdk` for Claude. Never add the OpenAI SDK.
- Relative imports end in `.js`. Every task ends with `npm test && npm run typecheck` passing.
- Cost (spec §14): one scheduler job, `--min-instances=0`. **`--max-instances=1`**, because plan 01's per-account Gmail sync lock only works within one process.
- npm scripts owned by other plans (`eval:triage`, `export-fixtures` from plan 01; `dev`, `build`, `start`, `test`, `typecheck`, `test:firestore` from plan 00) must not be redefined. This plan only adds `auth`, `check:access`, `setup:gcp`, `lint:sh`, `deploy`, `gmail:watch` and `smoke`.

## Review Focus

1. **OAuth consent screen left in "Testing".** Refresh tokens then die after 7 days, and both inboxes silently stop syncing a week later. Expected: the auth script warns loudly whenever Google says the refresh token expires. *Pinned by:* Task 1 test `tokenWarnings flags an expiring refresh token`, plus the docs checkbox in Task 1.
2. **Pub/Sub topic missing the Gmail publisher grant.** `users.watch` fails (or pushes never arrive) and mail only syncs on the 5-minute catch-up tick. Expected: setup grants `roles/pubsub.publisher` to `gmail-api-push@system.gserviceaccount.com`, and `gmail:watch` explains the fix when watch fails. *Pinned by:* Task 2 test `grants Gmail's push service account publish rights on the topic`, and Task 6 test `watchErrorHint explains a missing publisher grant`.
3. **OIDC audience vs `PUBLIC_BASE_URL` mismatch.** This covers a trailing slash, the first deploy happening before the URL is known, and the real URL differing from the predicted one. Every Pub/Sub push and tick would then get a 401. Expected: audience equals exactly `PUBLIC_BASE_URL + path` in all three places, and the first deploy works. *Pinned by:* Task 6 tests `OIDC audiences equal PUBLIC_BASE_URL + path exactly` and `when the real URL differs…`, and Task 5 test `Google-called routes reject requests without OIDC`.
4. **Cloud Tasks OIDC needs `iam.serviceAccountUser`.** `runtime@` must be able to act as `invoker@`, or every WhatsApp message fails to enqueue and the bot never replies. *Pinned by:* Task 2 test `lets runtime@ act as invoker@…`.
5. **Secrets echoed into shell history, the process list, or logs.** *Pinned by:* Task 1 test `writeSecret sends the value on stdin only`, Task 2 test `set-secret.sh passes the value on stdin, never as an argument` and `never puts the access token on a command line`, and Task 6 test `deploys with secrets from Secret Manager and plain env from .env (no secrets, no PORT)`.

---

## File map

```
AGENTS.md, CLAUDE.md                 # Task 1: instructions for coding agents
docs/setup.md                        # Tasks 1, 3, 6: runbook (GCP + OAuth, Meta, local dev, deploy)
docs/e2e-checklist.md                # Task 7
scripts/lib/secrets.ts               # Task 1: Secret Manager via gcloud (stdin only), ALL_SECRET_KEYS
scripts/lib/oauth.ts                 # Task 1: pure helpers for auth-google
scripts/lib/access.ts                # Task 1: pure classification for check-access
scripts/auth-google.ts               # Task 1: npm run auth -- personal|school
scripts/check-access.ts              # Task 1: npm run check:access -- personal|school
scripts/lib/common.sh                # Task 2: shared bash helpers + resource names
scripts/setup-gcp.sh                 # Task 2: npm run setup:gcp
scripts/set-secret.sh                # Task 2: store one secret value safely
Dockerfile, .dockerignore, .gcloudignore   # Task 4
src/app.ts                           # Task 5: composition (buildDeps, buildApp, chooseStoreKind, REGISTRARS)
src/main.ts                          # Task 5: entry point (listen, SIGTERM)
scripts/lib/deploy-env.ts            # Task 6: Cloud Run plain env from .env (pure)
scripts/render-run-env.ts            # Task 6: writes the env-vars YAML for deploy.sh
scripts/deploy.sh                    # Task 6: npm run deploy
scripts/lib/watch.ts                 # Task 6: watch error hints (pure)
scripts/gmail-watch.ts               # Task 6: npm run gmail:watch
scripts/lib/smoke.ts                 # Task 7: pure helpers for smoke
scripts/smoke.ts                     # Task 7: npm run smoke -- <command>
test/helpers/fake-cli.ts             # Task 2: fake gcloud/curl/npm on PATH
test/scripts/*.test.ts, test/infra/*.test.ts, test/main.test.ts
```

---

# PHASE A: runs in parallel with plans 01–05 (needs only plan 00)

### Task 1: Step 0 risk checks: AGENTS.md, Google OAuth script, access check, setup guide part 1

**Files:**
- Create: `AGENTS.md`, `CLAUDE.md`, `scripts/lib/secrets.ts`, `scripts/lib/oauth.ts`, `scripts/lib/access.ts`, `scripts/auth-google.ts`, `scripts/check-access.ts`, `docs/setup.md`
- Modify: `package.json` (name + scripts, via `npm pkg set`)
- Test: `test/infra/agents-md.test.ts`, `test/scripts/secrets.test.ts`, `test/scripts/oauth.test.ts`, `test/scripts/access.test.ts`

**Interfaces:**
- Consumes (plan 00): `GOOGLE_SCOPES: string[]` and `isInvalidGrant(err: unknown): boolean` from `src/google/auth.ts`; `AccountId` from `src/types.ts`.
- Produces:
  - `scripts/lib/secrets.ts`: `ALL_SECRET_KEYS` (readonly tuple of the 8 secret names), `type Runner = (cmd: string, args: string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>`, `defaultRunner: Runner`, `projectFromEnv(env): string | null`, `secretExists(name, project, run?): Promise<boolean>`, `writeSecret(name, value, project, run?): Promise<void>`, `readSecret(name, project, run?): Promise<string | null>`, `fillFromSecretManager(env, keys, project, run?): Promise<string[]>` (returns the names it filled).
  - `scripts/lib/oauth.ts`: `type SaveTarget = "auto" | "env" | "secret" | "both"`, `parseAccountArg(argv): AccountId`, `parseAuthArgs(argv): { account: AccountId; to: SaveTarget }`, `refreshTokenKey(account)`, `scopeReport(requested, granted): { granted: string[]; missing: string[] }`, `tokenWarnings(tokens: Record<string, unknown>): string[]`, `upsertEnvLine(content, key, value): string`, `readCallback(url: URL, expectedState: string): CallbackResult`.
  - `scripts/lib/access.ts`: `type ApiName = "gmail" | "calendar" | "classroom"`, `type AccessKind = "ok" | "invalid_grant" | "scope_missing" | "api_not_enabled" | "blocked_by_admin" | "other"`, `interface AccessResult { api; kind; status: number | null; reason: string }`, `okResult(api)`, `classifyGoogleError(api, err)`, `formatResult(r)`, `adviceFor(account, results): string[]`.
  - npm scripts `auth` and `check:access`.

- [x] **Step 1: Write the failing tests**

`test/infra/agents-md.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("agent instructions", () => {
  const agents = readFileSync("AGENTS.md", "utf8");
  it("AGENTS.md covers reading order, TDD, contracts, commits and the Anthropic SDK", () => {
    for (const needle of [
      "docs/build-prompt.md",
      "docs/superpowers/specs/2026-10-13-kiasu-design.md",
      "docs/superpowers/plans/",
      "first unchecked step",
      "TDD",
      "Contract change",
      "Commit after each task",
      "@anthropic-ai/sdk",
      "OpenAI",
    ]) {
      expect(agents, needle).toContain(needle);
    }
  });
  it("CLAUDE.md points at AGENTS.md", () => {
    expect(readFileSync("CLAUDE.md", "utf8")).toContain("@AGENTS.md");
  });
  it("no committed instruction file contains a real phone number", () => {
    expect(agents).not.toMatch(/\b65\d{8}\b/);
  });
});
```

`test/scripts/secrets.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  writeSecret, readSecret, fillFromSecretManager, projectFromEnv, ALL_SECRET_KEYS, type Runner,
} from "../../scripts/lib/secrets.js";

function fakeRunner(responses: Record<string, { code: number; stdout?: string; stderr?: string }>) {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const run: Runner = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    const key = Object.keys(responses).find((k) => args.join(" ").includes(k));
    const r = key ? responses[key]! : { code: 1 };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

describe("secrets helpers", () => {
  it("lists the 8 secrets from spec §12", () => {
    expect([...ALL_SECRET_KEYS].sort()).toEqual([
      "ANTHROPIC_API_KEY", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_REFRESH_TOKEN_PERSONAL", "GOOGLE_REFRESH_TOKEN_SCHOOL",
      "WA_ACCESS_TOKEN", "WA_APP_SECRET", "WA_VERIFY_TOKEN",
    ]);
  });

  it("writeSecret sends the value on stdin only", async () => {
    const { run, calls } = fakeRunner({ "versions add": { code: 0 } });
    await writeSecret("GOOGLE_REFRESH_TOKEN_SCHOOL", "1//refresh-xyz", "demo-proj", run);
    expect(calls[0]!.cmd).toBe("gcloud");
    expect(calls[0]!.args).toEqual([
      "secrets", "versions", "add", "GOOGLE_REFRESH_TOKEN_SCHOOL", "--data-file=-", "--project=demo-proj", "--format=none",
    ]);
    expect(calls[0]!.args.join(" ")).not.toContain("refresh-xyz");
    expect(calls[0]!.input).toBe("1//refresh-xyz");
  });

  it("writeSecret errors without leaking the value", async () => {
    const { run } = fakeRunner({ "versions add": { code: 1, stderr: "NOT_FOUND: Secret [X] not found" } });
    const err = await writeSecret("X", "super-secret", "p", run).catch((e: Error) => e);
    expect(String(err)).toMatch(/NOT_FOUND/);
    expect(String(err)).not.toContain("super-secret");
  });

  it("readSecret returns the value, or null when missing or empty", async () => {
    expect(await readSecret("A", "p", fakeRunner({ "--secret=A": { code: 0, stdout: "val\n" } }).run)).toBe("val");
    expect(await readSecret("A", "p", fakeRunner({}).run)).toBeNull();
    expect(await readSecret("A", "p", fakeRunner({ "--secret=A": { code: 0, stdout: "" } }).run)).toBeNull();
  });

  it("fillFromSecretManager fills only empty keys and reports names", async () => {
    const env: Record<string, string | undefined> = { A: "local", B: "" };
    const { run, calls } = fakeRunner({ "--secret=B": { code: 0, stdout: "from-sm" }, "--secret=C": { code: 1 } });
    expect(await fillFromSecretManager(env, ["A", "B", "C"], "p", run)).toEqual(["B"]);
    expect(env).toEqual({ A: "local", B: "from-sm" });
    expect(calls.map((c) => c.args.find((a) => a.startsWith("--secret=")))).toEqual(["--secret=B", "--secret=C"]);
    expect(await fillFromSecretManager(env, ["Z"], null, run)).toEqual([]);
  });

  it("projectFromEnv ignores the .env.example placeholder", () => {
    expect(projectFromEnv({ GCP_PROJECT: "your-gcp-project" })).toBeNull();
    expect(projectFromEnv({})).toBeNull();
    expect(projectFromEnv({ GCP_PROJECT: "kiasu-123" })).toBe("kiasu-123");
  });
});
```

`test/scripts/oauth.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  parseAuthArgs, parseAccountArg, refreshTokenKey, scopeReport, tokenWarnings, upsertEnvLine, readCallback,
} from "../../scripts/lib/oauth.js";

describe("oauth helpers", () => {
  it("parses account and --to", () => {
    expect(parseAuthArgs(["school"])).toEqual({ account: "school", to: "auto" });
    expect(parseAuthArgs(["personal", "--to=env"])).toEqual({ account: "personal", to: "env" });
    expect(() => parseAuthArgs(["work"])).toThrow(/personal\|school/);
    expect(() => parseAuthArgs(["school", "--to=cloud"])).toThrow(/--to=/);
    expect(() => parseAccountArg([])).toThrow(/personal\|school/);
  });

  it("maps accounts to refresh-token keys", () => {
    expect(refreshTokenKey("personal")).toBe("GOOGLE_REFRESH_TOKEN_PERSONAL");
    expect(refreshTokenKey("school")).toBe("GOOGLE_REFRESH_TOKEN_SCHOOL");
  });

  it("reports granted and missing scopes from a space-separated string or a list", () => {
    const req = ["a", "b", "c"];
    expect(scopeReport(req, "b a")).toEqual({ granted: ["a", "b"], missing: ["c"] });
    expect(scopeReport(req, ["c"])).toEqual({ granted: ["c"], missing: ["a", "b"] });
    expect(scopeReport(req, undefined)).toEqual({ granted: [], missing: ["a", "b", "c"] });
  });

  it("tokenWarnings flags an expiring refresh token", () => {
    expect(tokenWarnings({ refresh_token: "1//x" })).toEqual([]);
    const w = tokenWarnings({ refresh_token: "1//x", refresh_token_expires_in: 604799 });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/7 day/);
    expect(w[0]).toMatch(/In production/);
  });

  it("tokenWarnings flags a missing refresh token", () => {
    expect(tokenWarnings({ access_token: "y" })[0]).toMatch(/No refresh token/);
  });

  it("upsertEnvLine replaces or appends and keeps other lines", () => {
    const env = "MY_WHATSAPP_NUMBER=6500000000\nGOOGLE_REFRESH_TOKEN_SCHOOL=old\n";
    expect(upsertEnvLine(env, "GOOGLE_REFRESH_TOKEN_SCHOOL", "new")).toBe(
      "MY_WHATSAPP_NUMBER=6500000000\nGOOGLE_REFRESH_TOKEN_SCHOOL=new\n");
    expect(upsertEnvLine("MY_WHATSAPP_NUMBER=6500000000", "GOOGLE_REFRESH_TOKEN_PERSONAL", "t")).toBe(
      "MY_WHATSAPP_NUMBER=6500000000\nGOOGLE_REFRESH_TOKEN_PERSONAL=t\n");
    expect(upsertEnvLine("", "K", "v")).toBe("K=v\n");
    expect(() => upsertEnvLine("", "K", "a\nb")).toThrow(/single line/);
  });

  it("readCallback handles code, error, state mismatch and noise", () => {
    const base = "http://127.0.0.1:5555";
    expect(readCallback(new URL(`${base}/?code=abc&state=s1`), "s1")).toEqual({ kind: "code", code: "abc" });
    expect(readCallback(new URL(`${base}/?error=access_denied&state=s1`), "s1")).toEqual({ kind: "error", error: "access_denied" });
    expect(readCallback(new URL(`${base}/?code=abc&state=evil`), "s1").kind).toBe("error");
    expect(readCallback(new URL(`${base}/favicon.ico`), "s1")).toEqual({ kind: "ignore" });
    expect(readCallback(new URL(`${base}/`), "s1")).toEqual({ kind: "ignore" });
  });
});
```

`test/scripts/access.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { classifyGoogleError, adviceFor, formatResult, okResult, type AccessResult } from "../../scripts/lib/access.js";

const gaxios = (status: number, error: unknown) => ({ message: "Request failed", response: { status, data: { error } } });

describe("classifyGoogleError", () => {
  it("invalid_grant", () => {
    const err = { message: "invalid_grant", response: { status: 400, data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } };
    expect(classifyGoogleError("gmail", err).kind).toBe("invalid_grant");
  });
  it("scope not granted", () => {
    const err = gaxios(403, { message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED",
      details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] });
    expect(classifyGoogleError("calendar", err)).toMatchObject({ kind: "scope_missing", status: 403 });
  });
  it("API disabled in our own GCP project", () => {
    const err = gaxios(403, { message: "Gmail API has not been used in project 123 before or it is disabled.",
      status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] });
    expect(classifyGoogleError("gmail", err).kind).toBe("api_not_enabled");
  });
  it("blocked by the school's admin", () => {
    expect(classifyGoogleError("classroom", gaxios(403, {
      message: "@ClassroomApiDisabled The user is not permitted to access the Classroom API.", status: "PERMISSION_DENIED",
    })).kind).toBe("blocked_by_admin");
    expect(classifyGoogleError("gmail", gaxios(400, {
      message: "Mail service not enabled", errors: [{ reason: "failedPrecondition" }], status: "FAILED_PRECONDITION",
    })).kind).toBe("blocked_by_admin");
  });
  it("anything else is other, with the message as reason", () => {
    const r = classifyGoogleError("gmail", new Error("getaddrinfo ENOTFOUND gmail.googleapis.com"));
    expect(r).toMatchObject({ kind: "other", status: null });
    expect(r.reason).toContain("ENOTFOUND");
  });
});

describe("adviceFor / formatResult", () => {
  const ok = (api: AccessResult["api"]) => okResult(api);
  const bad = (api: AccessResult["api"], kind: AccessResult["kind"]): AccessResult => ({ api, kind, status: 403, reason: "x" });

  it("all ok", () => {
    expect(adviceFor("school", [ok("gmail"), ok("calendar"), ok("classroom")])).toEqual([
      "All good: the school account can reach Gmail, Calendar and Classroom.",
    ]);
  });
  it("Gmail blocked: prints both §13 fallbacks", () => {
    const a = adviceFor("school", [bad("gmail", "blocked_by_admin"), ok("calendar"), ok("classroom")]).join("\n");
    expect(a).toContain("(a) Gmail auto-forward");
    expect(a).toContain("(b) A Google Apps Script");
  });
  it("only Classroom blocked: suggests CLASSROOM_ENABLED=false and no mail fallback", () => {
    const a = adviceFor("school", [ok("gmail"), ok("calendar"), bad("classroom", "blocked_by_admin")]).join("\n");
    expect(a).toContain("CLASSROOM_ENABLED=false");
    expect(a).not.toContain("auto-forward");
  });
  it("invalid_grant: re-run auth for that account", () => {
    expect(adviceFor("personal", [bad("gmail", "invalid_grant")]).join("\n")).toContain("npm run auth -- personal");
  });
  it("formats results", () => {
    expect(formatResult(ok("gmail"))).toBe("✅ gmail");
    expect(formatResult(bad("classroom", "blocked_by_admin"))).toBe("❌ classroom: blocked_by_admin (403): x");
  });
});
```

- [x] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run test/infra/agents-md.test.ts test/scripts`
Expected: FAIL. `AGENTS.md` doesn't exist (ENOENT), and the `scripts/lib/*.js` modules aren't found.

- [x] **Step 3: Write `AGENTS.md` and `CLAUDE.md`**

`AGENTS.md`:
````markdown
# Instructions for coding agents (Codex, Cursor, Claude Code, …)

This repo is **kiasu-assistant**: a single-user assistant that reads my personal and school Gmail,
Google Calendar and Google Classroom, keeps a task list, and talks to me on WhatsApp.
Node 24 + TypeScript (ESM), Fastify, Zod, vitest, Firestore, Cloud Run.

## Read first, in this order
1. `docs/build-prompt.md`: how this build is run, and in what order.
2. The spec: `docs/superpowers/specs/2026-10-13-kiasu-design.md`.
3. The plans in `docs/superpowers/plans/`, in numeric order. Plan 00 (foundation) defines the shared contracts.

Then open the plan you're executing and continue from its **first unchecked step** (`- [ ]`).
Tick each step (`- [x]`) as you finish it. Don't skip steps or reorder tasks.

## Rules
- **TDD.** Write the failing test, run it and watch it fail, write the minimal code, run it and watch it pass.
  Every task ends with `npm test && npm run typecheck` passing.
- **Don't change the shared contracts**: `src/types.ts`, `src/ports.ts`, `src/store/types.ts`,
  `src/lib/clock.ts`, `src/server.ts` (`RouteRegistrar`), `src/items/*` signatures, `test/helpers/deps.ts`.
  The only exception is a change the plan names in a "Contract change" note.
- **Commit after each task**, using the message in that task's commit step. Never commit `.env`,
  secrets, or real email fixtures (`evals/triage/fixtures/`, `evals/triage/labels.json`).
- **Always use `@anthropic-ai/sdk`** for Claude. Never install, import or switch to the OpenAI SDK
  (`openai`) or any "OpenAI-compatible" client, even if a tool or error message suggests it. Model IDs come
  from `TRIAGE_MODEL` / `CHAT_MODEL`.
- Gmail access is read-only. No code path may send, delete, modify or forward email.
- Never print or log secrets or email bodies. Set secrets with `scripts/set-secret.sh NAME` (stdin, not argv).
  Never write my WhatsApp number into a committed file. It lives only in `.env` as `MY_WHATSAPP_NUMBER`.
- Relative imports end in `.js` (NodeNext ESM). Bash scripts must run on macOS `/bin/bash` 3.2 and pass `shellcheck`.
- If a step's expected output doesn't match, stop and debug (find the root cause). Don't weaken the test.
````

`CLAUDE.md`:
```markdown
# CLAUDE.md

@AGENTS.md

Everything for coding agents is in `AGENTS.md` (imported above). Read it first, then `docs/build-prompt.md`.
```

- [x] **Step 4: Implement `scripts/lib/secrets.ts`**

```ts
import { spawn } from "node:child_process";

/** Every Secret Manager secret the service uses (spec §12). Mirrored in scripts/lib/common.sh (a test checks it). */
export const ALL_SECRET_KEYS = [
  "ANTHROPIC_API_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "WA_ACCESS_TOKEN",
  "WA_APP_SECRET",
  "WA_VERIFY_TOKEN",
  "GOOGLE_REFRESH_TOKEN_PERSONAL",
  "GOOGLE_REFRESH_TOKEN_SCHOOL",
] as const;
export type SecretKey = (typeof ALL_SECRET_KEYS)[number];

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs a command without a shell. `input` goes to stdin, so it never appears in argv or the process list. */
export type Runner = (cmd: string, args: string[], input?: string) => Promise<RunResult>;

export const defaultRunner: Runner = (cmd, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });

/** GCP_PROJECT, unless it's unset or still the .env.example placeholder. */
export function projectFromEnv(env: Record<string, string | undefined>): string | null {
  const p = env.GCP_PROJECT?.trim();
  return p && p !== "your-gcp-project" ? p : null;
}

export async function secretExists(name: string, project: string, run: Runner = defaultRunner): Promise<boolean> {
  const r = await run("gcloud", ["secrets", "describe", name, `--project=${project}`, "--format=value(name)"]);
  return r.code === 0;
}

export async function writeSecret(name: string, value: string, project: string, run: Runner = defaultRunner): Promise<void> {
  const r = await run(
    "gcloud",
    ["secrets", "versions", "add", name, "--data-file=-", `--project=${project}`, "--format=none"],
    value,
  );
  if (r.code !== 0) throw new Error(`gcloud secrets versions add ${name} failed: ${r.stderr.trim()}`);
}

/** The latest enabled version, or null if the secret is missing or has no versions. */
export async function readSecret(name: string, project: string, run: Runner = defaultRunner): Promise<string | null> {
  const r = await run("gcloud", ["secrets", "versions", "access", "latest", `--secret=${name}`, `--project=${project}`]);
  if (r.code !== 0) return null;
  const value = r.stdout.trimEnd();
  return value === "" ? null : value;
}

/**
 * For each key that's empty in `env`, copies the latest Secret Manager value into it.
 * Returns the names (never the values) that were filled. Does nothing without a project.
 */
export async function fillFromSecretManager(
  env: Record<string, string | undefined>,
  keys: readonly string[],
  project: string | null,
  run: Runner = defaultRunner,
): Promise<string[]> {
  if (!project) return [];
  const filled: string[] = [];
  for (const key of keys) {
    if (env[key]) continue;
    const value = await readSecret(key, project, run);
    if (value !== null) {
      env[key] = value;
      filled.push(key);
    }
  }
  return filled;
}
```

- [x] **Step 5: Implement `scripts/lib/oauth.ts`**

```ts
/** Pure helpers for scripts/auth-google.ts. */
import type { AccountId } from "../../src/types.js";

export type SaveTarget = "auto" | "env" | "secret" | "both";

export interface AuthArgs {
  account: AccountId;
  to: SaveTarget;
}

export const AUTH_USAGE = "Usage: npm run auth -- personal|school [--to=auto|env|secret|both]";

export function parseAccountArg(argv: string[]): AccountId {
  const account = argv.find((a) => !a.startsWith("--"));
  if (account !== "personal" && account !== "school") throw new Error(AUTH_USAGE);
  return account;
}

export function parseAuthArgs(argv: string[]): AuthArgs {
  const account = parseAccountArg(argv);
  const toFlag = argv.find((a) => a.startsWith("--to="));
  const to = toFlag ? toFlag.slice("--to=".length) : "auto";
  if (to !== "auto" && to !== "env" && to !== "secret" && to !== "both") throw new Error(AUTH_USAGE);
  return { account, to };
}

export function refreshTokenKey(account: AccountId): "GOOGLE_REFRESH_TOKEN_PERSONAL" | "GOOGLE_REFRESH_TOKEN_SCHOOL" {
  return account === "personal" ? "GOOGLE_REFRESH_TOKEN_PERSONAL" : "GOOGLE_REFRESH_TOKEN_SCHOOL";
}

export function scopeReport(
  requested: readonly string[],
  granted: readonly string[] | string | undefined,
): { granted: string[]; missing: string[] } {
  const list = typeof granted === "string" ? granted.split(/\s+/).filter(Boolean) : [...(granted ?? [])];
  return {
    granted: requested.filter((s) => list.includes(s)),
    missing: requested.filter((s) => !list.includes(s)),
  };
}

/** Warnings about a token response. Google only sets refresh_token_expires_in when the refresh token will expire. */
export function tokenWarnings(tokens: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (!tokens.refresh_token) {
    out.push(
      "No refresh token was returned. Remove the app at https://myaccount.google.com/permissions for this account, then run auth again.",
    );
  }
  const expiresIn = tokens.refresh_token_expires_in;
  if (typeof expiresIn === "number") {
    const days = Math.round(expiresIn / 86_400);
    out.push(
      `This refresh token expires in about ${days} day(s). If the OAuth consent screen is in "Testing", ` +
        `publish it ("In production", docs/setup.md step 3) and run auth again.`,
    );
  }
  return out;
}

/** Sets KEY=value in .env content, replacing an existing line or appending one. Other lines are untouched. */
export function upsertEnvLine(content: string, key: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${key} value must be a single line`);
  const line = `${key}=${value}`;
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  return lines.join("\n") + "\n";
}

export type CallbackResult = { kind: "code"; code: string } | { kind: "error"; error: string } | { kind: "ignore" };

/** Reads a request to the loopback redirect URI (http://127.0.0.1:<port>/). */
export function readCallback(url: URL, expectedState: string): CallbackResult {
  if (url.pathname !== "/") return { kind: "ignore" };
  const error = url.searchParams.get("error");
  if (error) return { kind: "error", error };
  const code = url.searchParams.get("code");
  if (!code) return { kind: "ignore" };
  if (url.searchParams.get("state") !== expectedState) {
    return { kind: "error", error: "state mismatch (possible CSRF); run auth again" };
  }
  return { kind: "code", code };
}
```

- [x] **Step 6: Implement `scripts/lib/access.ts`**

```ts
/** Pure classification of Google API probe results for scripts/check-access.ts (spec §13 step 0). */
import { isInvalidGrant } from "../../src/google/auth.js";
import type { AccountId } from "../../src/types.js";

export type ApiName = "gmail" | "calendar" | "classroom";
export type AccessKind = "ok" | "invalid_grant" | "scope_missing" | "api_not_enabled" | "blocked_by_admin" | "other";

export interface AccessResult {
  api: ApiName;
  kind: AccessKind;
  status: number | null;
  reason: string;
}

interface GaxiosLike {
  message?: string;
  status?: number;
  code?: number | string;
  response?: {
    status?: number;
    data?: {
      error?:
        | string
        | {
            message?: string;
            status?: string;
            errors?: Array<{ reason?: string; message?: string }>;
            details?: Array<{ reason?: string }>;
          };
      error_description?: string;
    };
  };
}

export function okResult(api: ApiName): AccessResult {
  return { api, kind: "ok", status: 200, reason: "" };
}

export function classifyGoogleError(api: ApiName, err: unknown): AccessResult {
  const e = (err ?? {}) as GaxiosLike;
  const status = e.response?.status ?? (typeof e.code === "number" ? e.code : null) ?? e.status ?? null;
  const body = e.response?.data?.error;
  const apiError = typeof body === "object" && body !== null ? body : undefined;
  const message = apiError?.message ?? e.response?.data?.error_description ?? e.message ?? String(err);
  const reasons = [
    ...(apiError?.errors ?? []).map((x) => x.reason ?? ""),
    ...(apiError?.details ?? []).map((x) => x.reason ?? ""),
    apiError?.status ?? "",
  ].join(" ");
  const text = `${reasons} ${message}`;

  let kind: AccessKind;
  if (isInvalidGrant(err)) kind = "invalid_grant";
  else if (/insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(text)) kind = "scope_missing";
  else if (/SERVICE_DISABLED|accessNotConfigured|has not been used in project/i.test(text)) kind = "api_not_enabled";
  else if (
    (status === 403 || status === 400) &&
    /admin|domain|not enabled for|disabled for|policy|service not enabled|ClassroomApiDisabled|failedPrecondition|FAILED_PRECONDITION/i.test(text)
  ) kind = "blocked_by_admin";
  else kind = "other";

  return { api, kind, status, reason: message.slice(0, 300) };
}

export function formatResult(r: AccessResult): string {
  if (r.kind === "ok") return `✅ ${r.api}`;
  return `❌ ${r.api}: ${r.kind}${r.status ? ` (${r.status})` : ""}: ${r.reason}`;
}

export function adviceFor(account: AccountId, results: AccessResult[]): string[] {
  const by = (api: ApiName) => results.find((r) => r.api === api);
  const failed = results.filter((r) => r.kind !== "ok");
  if (failed.length === 0) return [`All good: the ${account} account can reach Gmail, Calendar and Classroom.`];

  const blocked = (r: AccessResult | undefined) => !!r && (r.kind === "blocked_by_admin" || r.kind === "other");
  const out: string[] = [];
  if (failed.some((r) => r.kind === "invalid_grant")) {
    out.push(`The refresh token was rejected (invalid_grant). Run: npm run auth -- ${account}`);
  }
  if (failed.some((r) => r.kind === "api_not_enabled")) {
    out.push(
      "An API is disabled in your GCP project. Run: npm run setup:gcp  " +
        "(or: gcloud services enable gmail.googleapis.com calendar-json.googleapis.com classroom.googleapis.com)",
    );
  }
  if (failed.some((r) => r.kind === "scope_missing")) {
    out.push(`Some permissions weren't granted. Run npm run auth -- ${account} again and tick every checkbox on the consent screen.`);
  }
  const gmail = by("gmail");
  if (blocked(gmail)) {
    out.push(
      'Gmail is blocked for this account. Use a fallback (spec §13, docs/setup.md "If the school account is blocked"):',
      "  (a) Gmail auto-forward from this account to your personal Gmail, with a filter label so triage can still tag it school.",
      "  (b) A Google Apps Script inside this account that posts new-mail summaries to the service (first-party, often allowed).",
    );
  }
  if (blocked(by("classroom")) && gmail?.kind === "ok") {
    out.push("Only Classroom is blocked. Set CLASSROOM_ENABLED=false in .env (and redeploy). Gmail and Calendar keep working.");
  }
  if (blocked(by("calendar"))) {
    out.push("Calendar is blocked for this account. Briefs won't show its events. Everything else still works.");
  }
  return out;
}
```

- [x] **Step 7: Run the unit tests**

Run: `npx vitest run test/infra/agents-md.test.ts test/scripts && npm run typecheck`
Expected: PASS. That's 3 tests in agents-md, 6 in secrets, 7 in oauth and 10 in access. Typecheck exits 0.

- [x] **Step 8: Write `scripts/auth-google.ts`**

```ts
/**
 * Google OAuth for one account (spec §12): Desktop-client loopback flow, offline access, consent prompt, PKCE.
 * Prints which scopes were granted and stores the refresh token in .env and/or Secret Manager.
 *
 * Usage: npm run auth -- personal|school [--to=auto|env|secret|both]
 *   auto (default): always .env, plus Secret Manager if GCP_PROJECT is set and the secret exists.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { GOOGLE_SCOPES } from "../src/google/auth.js";
import {
  parseAuthArgs, readCallback, refreshTokenKey, scopeReport, tokenWarnings, upsertEnvLine, type SaveTarget,
} from "./lib/oauth.js";
import { fillFromSecretManager, projectFromEnv, secretExists, writeSecret } from "./lib/secrets.js";

const ENV_PATH = ".env";
const TIMEOUT_MS = 5 * 60_000;

function waitForCode(server: Server, redirectUri: string, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 5 minutes waiting for the browser sign-in."));
    }, TIMEOUT_MS);
    server.on("request", (req, res) => {
      const result = readCallback(new URL(req.url ?? "/", redirectUri), state);
      if (result.kind === "ignore") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(result.kind === "code"
        ? "Signed in. You can close this tab and go back to the terminal."
        : `Sign-in failed: ${result.error}`);
      clearTimeout(timer);
      server.close();
      if (result.kind === "code") resolve(result.code);
      else reject(new Error(`Google returned: ${result.error}`));
    });
  });
}

async function save(key: string, value: string, to: SaveTarget, project: string | null): Promise<string[]> {
  const where: string[] = [];
  let toSecret = to === "secret" || to === "both";
  if (to === "auto" && project) toSecret = await secretExists(key, project);
  if (toSecret) {
    if (!project) throw new Error("GCP_PROJECT isn't set, so the token can't go to Secret Manager. Use --to=env, or set GCP_PROJECT.");
    await writeSecret(key, value, project);
    where.push(`Secret Manager (${key} in ${project})`);
  }
  if (to !== "secret") {
    const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
    writeFileSync(ENV_PATH, upsertEnvLine(current, key, value), { mode: 0o600 });
    where.push(`.env (${key})`);
  }
  return where;
}

async function main(): Promise<number> {
  const { account, to } = parseAuthArgs(process.argv.slice(2));
  const project = projectFromEnv(process.env);
  await fillFromSecretManager(process.env, ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"], project);
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET aren't set. Create the Desktop OAuth client (docs/setup.md step 4) and put both in .env.");
    return 1;
  }

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const state = randomBytes(16).toString("hex");
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });

  console.log(`\nSign in with your ${account.toUpperCase()} Google account.`);
  console.log(`If Google says "Google hasn't verified this app", click Advanced, then "Go to … (unsafe)". It's your own app.`);
  console.log(`If it says "Access blocked" or mentions your administrator, the school blocks third-party apps: see docs/setup.md step 7.\n`);
  console.log(`${authUrl}\n`);
  if (process.platform === "darwin") spawn("open", [authUrl], { stdio: "ignore", detached: true }).unref();

  const code = await waitForCode(server, redirectUri, state);
  const { tokens } = await client.getToken({ code, codeVerifier });

  const { granted, missing } = scopeReport(GOOGLE_SCOPES, tokens.scope ?? undefined);
  console.log("\nScopes:");
  for (const s of granted) console.log(`  ✅ ${s}`);
  for (const s of missing) console.log(`  ❌ ${s} (not granted)`);
  for (const w of tokenWarnings(tokens as unknown as Record<string, unknown>)) console.warn(`\n⚠️  ${w}`);
  if (!tokens.refresh_token) return 1;

  const key = refreshTokenKey(account);
  const where = await save(key, tokens.refresh_token, to, project);
  console.log(`\nSaved the refresh token to: ${where.join(" and ")}. (The token itself is never printed.)`);
  if (where.some((w) => w.startsWith("Secret Manager"))) {
    console.log("If the service is already deployed, start a new revision so it picks up the new token:");
    console.log(`  gcloud run services update kiasu-assistant --region=asia-southeast1 --update-env-vars=SECRETS_REFRESHED_AT=$(date +%s)`);
  }
  console.log(`\nNext: npm run check:access -- ${account}`);
  return missing.length === 0 ? 0 : 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (err: unknown) => { console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; },
);
```

- [x] **Step 9: Write `scripts/check-access.ts`**

```ts
/**
 * Spec §13 step 0: with the stored refresh token, can this account reach Gmail, Calendar and Classroom?
 * Usage: npm run check:access -- personal|school
 * The token comes from .env, or from Secret Manager if .env doesn't have it.
 */
import { google } from "googleapis";
import { GOOGLE_SCOPES, isInvalidGrant } from "../src/google/auth.js";
import { parseAccountArg, refreshTokenKey, scopeReport } from "./lib/oauth.js";
import { adviceFor, classifyGoogleError, formatResult, okResult, type AccessResult, type ApiName } from "./lib/access.js";
import { fillFromSecretManager, projectFromEnv } from "./lib/secrets.js";

async function main(): Promise<number> {
  const account = parseAccountArg(process.argv.slice(2));
  const key = refreshTokenKey(account);
  await fillFromSecretManager(process.env, ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", key], projectFromEnv(process.env));
  const { GOOGLE_OAUTH_CLIENT_ID: id, GOOGLE_OAUTH_CLIENT_SECRET: secret } = process.env;
  const refreshToken = process.env[key];
  if (!id || !secret) {
    console.error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET aren't set (.env or Secret Manager).");
    return 1;
  }
  if (!refreshToken) {
    console.error(`No ${key} in .env or Secret Manager. Run: npm run auth -- ${account}`);
    return 1;
  }

  const auth = new google.auth.OAuth2(id, secret);
  auth.setCredentials({ refresh_token: refreshToken });

  try {
    const { token } = await auth.getAccessToken();
    const info = await auth.getTokenInfo(token ?? "");
    const { missing } = scopeReport(GOOGLE_SCOPES, info.scopes);
    console.log(missing.length === 0 ? "✅ all 5 scopes granted" : `⚠️  scopes not granted: ${missing.join(", ")}`);
  } catch (err) {
    if (isInvalidGrant(err)) {
      console.log(`❌ token rejected (invalid_grant). Run: npm run auth -- ${account}`);
    } else {
      console.log(`❌ couldn't get an access token: ${classifyGoogleError("gmail", err).reason}`);
    }
    return 1;
  }

  const probes: Record<ApiName, () => Promise<string>> = {
    gmail: async () =>
      `signed in as ${(await google.gmail({ version: "v1", auth }).users.getProfile({ userId: "me" })).data.emailAddress ?? "?"}`,
    calendar: async () =>
      `${(await google.calendar({ version: "v3", auth }).calendarList.list({ maxResults: 50 })).data.items?.length ?? 0} calendars`,
    classroom: async () =>
      `${(await google.classroom({ version: "v1", auth }).courses.list({ studentId: "me", pageSize: 20 })).data.courses?.length ?? 0} courses`,
  };

  const results: AccessResult[] = [];
  for (const api of ["gmail", "calendar", "classroom"] as const) {
    try {
      const detail = await probes[api]();
      results.push(okResult(api));
      console.log(`${formatResult(okResult(api))}  ${detail}`);
    } catch (err) {
      const r = classifyGoogleError(api, err);
      results.push(r);
      console.log(formatResult(r));
    }
  }
  console.log("");
  for (const line of adviceFor(account, results)) console.log(line);
  return results.every((r) => r.kind === "ok") ? 0 : 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; },
);
```

- [x] **Step 10: Add the npm scripts and the package name**

Run:
```bash
npm pkg set name=kiasu-assistant
npm pkg set "scripts.auth=tsx --env-file=.env scripts/auth-google.ts"
npm pkg set "scripts.check:access=tsx --env-file=.env scripts/check-access.ts"
npm pkg get name scripts.auth "scripts.check:access"
```
Expected: the last command prints the three values above.

- [x] **Step 11: Write `docs/setup.md` (part 1: Google Cloud + OAuth + Step 0)**

````markdown
# kiasu-assistant setup

Runbook for a fresh machine and a fresh Google Cloud project. Commands run from `~/Kiasu-assistant`.
Never paste a secret onto a command line. Use `scripts/set-secret.sh NAME` (it prompts with hidden input).

## Part 1: Google Cloud project, OAuth, and Step 0 risk checks (spec §13)

### 0. Prerequisites
- [ ] Node 24 (`node --version` shows `v24.x`), then `npm install`.
- [ ] `gcloud` installed (`gcloud --version` shows 584 or newer).
- [ ] `gcloud auth login` (your personal Google account owns the GCP project).
- [ ] `gcloud auth application-default login` (lets local scripts reach Firestore and Secret Manager).
- [ ] `cp .env.example .env`. Keep the existing `MY_WHATSAPP_NUMBER` line if `.env` already has one.

### 1. Create the project and link billing
Billing is required for Cloud Run, Scheduler and Tasks. This setup stays inside the free tiers (spec §14).
```bash
gcloud projects create kiasu-assistant-<random-suffix> --name="Kiasu Assistant"
gcloud billing accounts list
gcloud billing projects link kiasu-assistant-<random-suffix> --billing-account=<ACCOUNT_ID>
gcloud config set project kiasu-assistant-<random-suffix>
```
Put `GCP_PROJECT=kiasu-assistant-<random-suffix>` and `GCP_REGION=asia-southeast1` in `.env`.

### 2. Enable the Google APIs needed for Step 0
`npm run setup:gcp` (Part 2) enables everything later. For Step 0 you only need:
```bash
gcloud services enable gmail.googleapis.com calendar-json.googleapis.com classroom.googleapis.com
```

### 3. OAuth consent screen: External, **In production**
Cloud Console → **Google Auth Platform** (APIs & Services → OAuth consent screen):
- [ ] **Branding:** app name `Kiasu Assistant`, user support email and developer contact = your personal address.
- [ ] **Audience:** user type **External**. Click **Publish app** so the status reads **In production**.
  *Testing mode expires refresh tokens after 7 days. The auth script warns if a token will expire.*
- [ ] **Data Access:** add the 5 scopes (`gmail.readonly`, `calendar.readonly`, `classroom.courses.readonly`,
  `classroom.coursework.me.readonly`, `classroom.announcements.readonly`). The app stays unverified. That's
  fine for personal use. You'll click past "Google hasn't verified this app".

### 4. Desktop OAuth client
Google Auth Platform → **Clients** → **Create client** → Application type **Desktop app** → name `kiasu-cli`.
Copy the client ID and secret into `.env` as `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
Open `.env` in an editor and paste them there. Don't use `echo … >> .env`, because that lands in shell history.
Desktop clients accept any `http://127.0.0.1:<port>` redirect, which is what the auth script uses.

### 5. Run Step 0
```bash
npm run auth -- personal --to=env
npm run check:access -- personal
npm run auth -- school --to=env
npm run check:access -- school
```
`auth` opens the browser. Pick the right account, tick every checkbox, and come back to the terminal. It prints
✅/❌ per scope and saves the refresh token to `.env` (after Part 2, re-run with the default `--to=auto`
to also store it in Secret Manager). `check:access` prints ✅/❌ for Gmail, Calendar and Classroom, plus what to do.

### 6. Step 0 results (fill in, no email addresses)
| Account | Date | Gmail | Calendar | Classroom | Decision |
|---|---|---|---|---|---|
| personal | | | | | |
| school | | | | | |

Decisions: all ✅ → continue. Only Classroom ❌ → set `CLASSROOM_ENABLED=false` in `.env` and continue.
Gmail ❌ on school → step 7, and tell the coordinator before plans 01/02 merge.

### 7. If the school account is blocked
Signs: the browser shows "Access blocked: … admin", or `check:access -- school` reports `blocked_by_admin` for Gmail.
Fallbacks, in order (spec §13):
- **(a) Auto-forward.** In school Gmail: Settings → Forwarding and POP/IMAP → Add a forwarding address
  (your personal Gmail) → confirm the code that arrives → "Forward a copy…". In personal Gmail, create a filter
  `deliveredto:(<school address>)` → Apply label `school`. Many school domains disable external forwarding. If the
  option is greyed out, try (b). Follow-up: plan 01 must treat label `school` in the personal inbox as `account: "school"`.
- **(b) Apps Script.** A script in the school account (script.google.com, time-driven trigger every 5 minutes)
  reads new mail with `GmailApp` and POSTs summaries to the service. This needs a new authenticated route, which
  is outside v1, so raise it with the coordinator before building it.
````

- [ ] (user) **Step 12: Run Step 0 for real (manual)**

Do docs/setup.md steps 0–5 now, then fill in the table in step 6.
Expected for `npm run check:access -- personal`:
```
✅ all 5 scopes granted
✅ gmail  signed in as <your personal address>
✅ calendar  N calendars
✅ classroom  0 courses
All good: the personal account can reach Gmail, Calendar and Classroom.
```
For school, either the same or one of the advice lines. Record the outcome in the step 6 table. If school Gmail is ❌, stop and report to the coordinator. Plans 01–05 can continue on the personal account.

- [x] **Step 13: Full suite**

Run: `npm test && npm run typecheck`
Expected: all tests pass, and typecheck exits 0.

- [x] **Step 14: Commit**

```bash
git add AGENTS.md CLAUDE.md scripts/lib/secrets.ts scripts/lib/oauth.ts scripts/lib/access.ts \
  scripts/auth-google.ts scripts/check-access.ts docs/setup.md package.json \
  test/infra/agents-md.test.ts test/scripts/secrets.test.ts test/scripts/oauth.test.ts test/scripts/access.test.ts
git status --short | grep -E '\.env$' && echo "STOP: .env is staged" || true
git commit -m "feat(infra): AGENTS.md, Google OAuth script, access check, setup guide part 1"
```

---

### Task 2: `scripts/setup-gcp.sh` (idempotent GCP setup) and `scripts/set-secret.sh`

**Files:**
- Create: `scripts/lib/common.sh`, `scripts/setup-gcp.sh`, `scripts/set-secret.sh`, `test/helpers/fake-cli.ts`
- Modify: `package.json` (scripts `setup:gcp`, `lint:sh`)
- Test: `test/scripts/setup-gcp.test.ts`

**Interfaces:**
- Consumes: `ALL_SECRET_KEYS` (Task 1).
- Produces:
  - `scripts/lib/common.sh`: variables `SERVICE_NAME=kiasu-assistant`, `TOPIC=gmail-push`, `SUBSCRIPTION=gmail-push-sub`, `QUEUE=inbound`, `SCHEDULER_JOB=tick`, `INVOKER_SA_NAME`, `RUNTIME_SA_NAME`, `GMAIL_PUSH_SA`, arrays `REQUIRED_SECRETS` and `OPTIONAL_SECRETS`, and functions `log`, `warn`, `die`, `run` (honours `DRY_RUN`), `exists`, `retry`, `dotenv_get KEY`, `load_project_env` (sets `GCP_PROJECT`, `GCP_REGION`, `INVOKER_SA`, `RUNTIME_SA`, and exports `CLOUDSDK_CORE_PROJECT`), and `project_number`.
  - `test/helpers/fake-cli.ts`: `runWithFakeCli(script, args, env, input?): { status, stdout, stderr, log: string[], dir }`. Task 6 reuses it.
  - npm scripts `setup:gcp` and `lint:sh`.

What the script grants, and why:

| Principal | Role | On | Why |
|---|---|---|---|
| `gmail-api-push@system.gserviceaccount.com` | `roles/pubsub.publisher` | topic `gmail-push` | Gmail `users.watch` publishes here |
| `runtime@` | `roles/datastore.user`, `roles/cloudtasks.enqueuer`, `roles/secretmanager.secretAccessor` | project | Firestore, enqueue tasks, read secrets |
| `runtime@` | `roles/iam.serviceAccountUser` | `invoker@` | creating a Cloud Task with an OIDC token for `invoker@` needs actAs |
| Pub/Sub service agent | `roles/iam.serviceAccountTokenCreator` | `invoker@` | signs push OIDC tokens |
| Cloud Tasks service agent | `roles/iam.serviceAccountUser` | `invoker@` | signs task OIDC tokens (per the Cloud Tasks docs) |
| `<number>-compute@developer.gserviceaccount.com` | `roles/run.builder` | project | `gcloud run deploy --source` builds as this account |

- [x] **Step 1: Write the fake CLI helper**

`test/helpers/fake-cli.ts`:
```ts
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
```

- [x] **Step 2: Write the failing test**

`test/scripts/setup-gcp.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runWithFakeCli } from "../helpers/fake-cli.js";
import { ALL_SECRET_KEYS } from "../../scripts/lib/secrets.js";

const ENV = { GCP_PROJECT: "demo-proj", GCP_REGION: "asia-southeast1" };
const has = (log: string[], prefix: string) => log.some((l) => l.startsWith(prefix));

describe("setup-gcp.sh", () => {
  it("creates everything on a fresh project", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", [], ENV);
    expect(r.status, r.stderr).toBe(0);
    expect(r.log.find((l) => l.startsWith("gcloud services enable"))).toMatch(
      /run\.googleapis\.com.*firestore.*pubsub.*cloudtasks.*cloudscheduler.*secretmanager.*gmail.*calendar-json.*classroom.*cloudbuild.*artifactregistry/);
    expect(has(r.log, "gcloud firestore databases create --database=(default) --location=asia-southeast1 --type=firestore-native")).toBe(true);
    expect(has(r.log, "gcloud iam service-accounts create invoker")).toBe(true);
    expect(has(r.log, "gcloud iam service-accounts create runtime")).toBe(true);
    expect(has(r.log, "gcloud pubsub topics create gmail-push")).toBe(true);
    expect(has(r.log, "gcloud tasks queues create inbound --location=asia-southeast1 --max-attempts=5")).toBe(true);
    for (const s of ALL_SECRET_KEYS) {
      expect(has(r.log, `gcloud secrets create ${s} --replication-policy=automatic`), s).toBe(true);
    }
  });

  it("grants Gmail's push service account publish rights on the topic", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", [], ENV);
    expect(has(r.log, "gcloud pubsub topics add-iam-policy-binding gmail-push --member=serviceAccount:gmail-api-push@system.gserviceaccount.com --role=roles/pubsub.publisher")).toBe(true);
  });

  it("lets runtime@ act as invoker@ (needed to create OIDC Cloud Tasks) and grants runtime roles", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", [], ENV);
    expect(has(r.log, "gcloud iam service-accounts add-iam-policy-binding invoker@demo-proj.iam.gserviceaccount.com --member=serviceAccount:runtime@demo-proj.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser")).toBe(true);
    for (const role of ["roles/datastore.user", "roles/cloudtasks.enqueuer", "roles/secretmanager.secretAccessor"]) {
      expect(has(r.log, `gcloud projects add-iam-policy-binding demo-proj --member=serviceAccount:runtime@demo-proj.iam.gserviceaccount.com --role=${role}`), role).toBe(true);
    }
    expect(has(r.log, "gcloud iam service-accounts add-iam-policy-binding invoker@demo-proj.iam.gserviceaccount.com --member=serviceAccount:service-123456789@gcp-sa-pubsub.iam.gserviceaccount.com --role=roles/iam.serviceAccountTokenCreator")).toBe(true);
    expect(has(r.log, "gcloud projects add-iam-policy-binding demo-proj --member=serviceAccount:123456789-compute@developer.gserviceaccount.com --role=roles/run.builder")).toBe(true);
  });

  it("never puts the access token on a command line", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", [], ENV);
    const curlArgs = r.log.filter((l) => l.startsWith("curl "));
    expect(curlArgs).toHaveLength(2);
    expect(curlArgs.join("\n")).not.toContain("fake-access-token");
    expect(r.log.filter((l) => l.startsWith("curl-stdin:")).join("\n")).toContain("Authorization: Bearer fake-access-token");
  });

  it("is idempotent: re-running against existing resources creates nothing and updates the queue", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", [], { ...ENV, FAKE_EXISTS: "true" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.log.filter((l) => / create /.test(l))).toEqual([]);
    expect(has(r.log, "gcloud tasks queues update inbound")).toBe(true);
  });

  it("--dry-run only reads; mutating commands are printed instead", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", ["--dry-run"], ENV);
    expect(r.status, r.stderr).toBe(0);
    expect(r.log.every((l) => / describe /.test(l) || l.startsWith("gcloud projects describe"))).toBe(true);
    expect(r.stdout).toContain("[dry-run] gcloud pubsub topics create gmail-push");
  });

  it("fails clearly without GCP_PROJECT", () => {
    const r = runWithFakeCli("scripts/setup-gcp.sh", [], { GCP_PROJECT: "" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Set GCP_PROJECT");
  });
});

describe("set-secret.sh", () => {
  it("set-secret.sh passes the value on stdin, never as an argument", () => {
    const r = runWithFakeCli("scripts/set-secret.sh", ["ANTHROPIC_API_KEY"], ENV, "sk-ant-secret-123\n");
    expect(r.status, r.stderr).toBe(0);
    expect(r.log.find((l) => l.startsWith("gcloud secrets versions add"))).toBe(
      "gcloud secrets versions add ANTHROPIC_API_KEY --data-file=- --format=none");
    expect(r.log).toContain("stdin: sk-ant-secret-123");
  });

  it("rejects unknown names and empty values", () => {
    expect(runWithFakeCli("scripts/set-secret.sh", ["NOPE"], ENV, "x\n").status).not.toBe(0);
    expect(runWithFakeCli("scripts/set-secret.sh", ["WA_APP_SECRET"], ENV, "\n").status).not.toBe(0);
  });
});

describe("secret names", () => {
  it("common.sh lists exactly ALL_SECRET_KEYS", () => {
    const sh = readFileSync("scripts/lib/common.sh", "utf8");
    const names = [...sh.matchAll(/^(?:REQUIRED|OPTIONAL)_SECRETS=\(([^)]*)\)/gm)].flatMap((m) => m[1]!.trim().split(/\s+/));
    expect(names.sort()).toEqual([...ALL_SECRET_KEYS].sort());
  });
});
```

- [x] **Step 3: Run the test to confirm it fails**

Run: `npx vitest run test/scripts/setup-gcp.test.ts`
Expected: FAIL. bash exits 127 (`scripts/setup-gcp.sh: No such file or directory`), and `common.sh` isn't found.

- [x] **Step 4: Write `scripts/lib/common.sh`**

```bash
# shellcheck shell=bash
# Shared helpers for scripts/setup-gcp.sh, scripts/deploy.sh and scripts/set-secret.sh.
# Source it; don't execute it. Must stay compatible with macOS /bin/bash 3.2:
# no associative arrays, no mapfile, and no expanding possibly-empty arrays under `set -u`.

SERVICE_NAME="kiasu-assistant"
TOPIC="gmail-push"
SUBSCRIPTION="gmail-push-sub"
QUEUE="inbound"
SCHEDULER_JOB="tick"
INVOKER_SA_NAME="invoker"
RUNTIME_SA_NAME="runtime"
GMAIL_PUSH_SA="gmail-api-push@system.gserviceaccount.com"

# Keep in sync with ALL_SECRET_KEYS in scripts/lib/secrets.ts (test/scripts/setup-gcp.test.ts checks this).
REQUIRED_SECRETS=(ANTHROPIC_API_KEY GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET WA_ACCESS_TOKEN WA_APP_SECRET WA_VERIFY_TOKEN)
OPTIONAL_SECRETS=(GOOGLE_REFRESH_TOKEN_PERSONAL GOOGLE_REFRESH_TOKEN_SCHOOL)

DRY_RUN="${DRY_RUN:-false}"

log() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Runs a mutating command, or only prints it when DRY_RUN=true.
run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# Runs a read-only probe with all output discarded. Returns its exit status.
exists() { "$@" >/dev/null 2>&1; }

# Retries up to 5 times (IAM on a brand-new service account can take a few seconds to propagate).
retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    if [[ "$n" -ge 5 ]]; then return 1; fi
    warn "retrying in $((n * 3))s: $*"
    sleep $((n * 3))
  done
}

# Prints KEY's value from the env file WITHOUT sourcing it (sourcing would execute its contents).
dotenv_get() {
  local key="$1" file="${ENV_FILE:-.env}"
  if [[ ! -f "$file" ]]; then return 0; fi
  { grep -E "^${key}=" "$file" || true; } | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'
}

# Sets GCP_PROJECT, GCP_REGION, INVOKER_SA, RUNTIME_SA and points every gcloud call at the project.
load_project_env() {
  GCP_PROJECT="${GCP_PROJECT:-$(dotenv_get GCP_PROJECT)}"
  GCP_REGION="${GCP_REGION:-$(dotenv_get GCP_REGION)}"
  GCP_REGION="${GCP_REGION:-asia-southeast1}"
  if [[ -z "$GCP_PROJECT" || "$GCP_PROJECT" == "your-gcp-project" ]]; then
    die "Set GCP_PROJECT (export it, or put it in .env)"
  fi
  export CLOUDSDK_CORE_PROJECT="$GCP_PROJECT"
  INVOKER_SA="${INVOKER_SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
  RUNTIME_SA="${RUNTIME_SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
}

project_number() {
  gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)'
}
```

- [x] **Step 5: Write `scripts/setup-gcp.sh`**

```bash
#!/usr/bin/env bash
# One-time, idempotent Google Cloud setup for kiasu-assistant. Safe to re-run at any time.
#
# Usage:  GCP_PROJECT=my-project [GCP_REGION=asia-southeast1] scripts/setup-gcp.sh [--dry-run]
#         (GCP_PROJECT / GCP_REGION fall back to the values in .env)
#
# Creates: APIs, Firestore (Native) database, service accounts invoker@ and runtime@,
# Pub/Sub topic gmail-push (+ Gmail publisher grant), Cloud Tasks queue inbound,
# empty Secret Manager secrets, and IAM bindings. The push subscription and the scheduler
# job are created by scripts/deploy.sh, because they need the service URL.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/common.sh
source scripts/lib/common.sh

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h | --help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

load_project_env
log "Project: $GCP_PROJECT  Region: $GCP_REGION  Dry run: $DRY_RUN"

APIS=(
  run.googleapis.com firestore.googleapis.com pubsub.googleapis.com cloudtasks.googleapis.com
  cloudscheduler.googleapis.com secretmanager.googleapis.com gmail.googleapis.com
  calendar-json.googleapis.com classroom.googleapis.com cloudbuild.googleapis.com
  artifactregistry.googleapis.com iam.googleapis.com storage.googleapis.com compute.googleapis.com
)
log "Enabling APIs (takes a minute the first time)"
run gcloud services enable "${APIS[@]}"

PROJECT_NUMBER="$(project_number 2>/dev/null || true)"
if [[ -z "$PROJECT_NUMBER" ]]; then
  [[ "$DRY_RUN" == "true" ]] || die "Could not read the project number for $GCP_PROJECT"
  PROJECT_NUMBER="PROJECT_NUMBER"
fi

log "Firestore (Native mode) in $GCP_REGION"
if exists gcloud firestore databases describe --database='(default)'; then
  log "  already exists"
else
  run gcloud firestore databases create --database='(default)' --location="$GCP_REGION" --type=firestore-native
fi

ensure_sa() {
  local name="$1" display="$2"
  if exists gcloud iam service-accounts describe "${name}@${GCP_PROJECT}.iam.gserviceaccount.com"; then
    log "  service account $name exists"
  else
    run gcloud iam service-accounts create "$name" --display-name="$display"
  fi
}
log "Service accounts"
ensure_sa "$INVOKER_SA_NAME" "kiasu-assistant OIDC invoker (Pub/Sub, Scheduler, Tasks)"
ensure_sa "$RUNTIME_SA_NAME" "kiasu-assistant Cloud Run runtime"

log "Pub/Sub topic $TOPIC + publish grant for Gmail"
if exists gcloud pubsub topics describe "$TOPIC"; then
  log "  topic exists"
else
  run gcloud pubsub topics create "$TOPIC"
fi
retry run gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
  --member="serviceAccount:${GMAIL_PUSH_SA}" --role=roles/pubsub.publisher --format=none

log "Cloud Tasks queue $QUEUE"
# One dispatch at a time keeps chat replies in order. 5 attempts with backoff ride out transient errors.
QUEUE_FLAGS=(--location="$GCP_REGION" --max-attempts=5 --min-backoff=10s --max-backoff=300s
  --max-doublings=4 --max-concurrent-dispatches=1 --max-dispatches-per-second=1)
if exists gcloud tasks queues describe "$QUEUE" --location="$GCP_REGION"; then
  run gcloud tasks queues update "$QUEUE" "${QUEUE_FLAGS[@]}"
else
  run gcloud tasks queues create "$QUEUE" "${QUEUE_FLAGS[@]}"
fi

log "Secrets (created empty; set values with scripts/set-secret.sh NAME)"
for secret in "${REQUIRED_SECRETS[@]}" "${OPTIONAL_SECRETS[@]}"; do
  if exists gcloud secrets describe "$secret"; then
    log "  $secret exists"
  else
    run gcloud secrets create "$secret" --replication-policy=automatic
  fi
done

log "IAM for runtime@ (Firestore, enqueue tasks, read secrets)"
for role in roles/datastore.user roles/cloudtasks.enqueuer roles/secretmanager.secretAccessor; do
  retry run gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
    --member="serviceAccount:${RUNTIME_SA}" --role="$role" --condition=None --format=none
done
# Creating a Cloud Task with an OIDC token for invoker@ requires actAs on invoker@.
retry run gcloud iam service-accounts add-iam-policy-binding "$INVOKER_SA" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/iam.serviceAccountUser --format=none

# Makes sure a Google-managed service agent exists before we grant it roles.
# The access token goes to curl on stdin (-H @-), never on a command line.
ensure_service_identity() {
  local service="$1"
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '[dry-run] generateServiceIdentity %s\n' "$service"
    return 0
  fi
  gcloud auth print-access-token | sed 's/^/Authorization: Bearer /' |
    curl -fsS -X POST -H @- -H 'Content-Type: application/json' -d '{}' \
      "https://serviceusage.googleapis.com/v1beta1/projects/${PROJECT_NUMBER}/services/${service}:generateServiceIdentity" \
      >/dev/null
}

log "Service agents (Pub/Sub and Cloud Tasks sign OIDC tokens as invoker@)"
ensure_service_identity pubsub.googleapis.com
ensure_service_identity cloudtasks.googleapis.com
retry run gcloud iam service-accounts add-iam-policy-binding "$INVOKER_SA" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role=roles/iam.serviceAccountTokenCreator --format=none
retry run gcloud iam service-accounts add-iam-policy-binding "$INVOKER_SA" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudtasks.iam.gserviceaccount.com" \
  --role=roles/iam.serviceAccountUser --format=none

log "Cloud Build (source deploys build as the Compute default service account)"
retry run gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/run.builder --condition=None --format=none

log "Done. Next: set secret values with scripts/set-secret.sh NAME (docs/setup.md Part 2)."
```

- [x] **Step 6: Write `scripts/set-secret.sh`**

```bash
#!/usr/bin/env bash
# Stores a new version of a Secret Manager secret. The value never appears in argv or shell history.
#
# Usage:  scripts/set-secret.sh NAME                 (prompts; input is hidden)
#         some-command | scripts/set-secret.sh NAME  (reads the first line of stdin)
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/common.sh
source scripts/lib/common.sh

name="${1:-}"
if [[ -z "$name" ]]; then die "Usage: scripts/set-secret.sh NAME"; fi
known=false
for s in "${REQUIRED_SECRETS[@]}" "${OPTIONAL_SECRETS[@]}"; do
  if [[ "$s" == "$name" ]]; then known=true; fi
done
if [[ "$known" != "true" ]]; then
  die "Unknown secret '$name'. Known: ${REQUIRED_SECRETS[*]} ${OPTIONAL_SECRETS[*]}"
fi

load_project_env

value=""
if [[ -t 0 ]]; then
  printf 'Value for %s (input hidden): ' "$name" >&2
  IFS= read -rs value || true
  printf '\n' >&2
else
  IFS= read -r value || true
fi
if [[ -z "$value" ]]; then die "Empty value; nothing stored"; fi

# printf is a shell builtin, so the value never shows up in the process list.
printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --format=none
log "Stored a new version of $name in $GCP_PROJECT"
```

Then make them executable:
```bash
chmod +x scripts/setup-gcp.sh scripts/set-secret.sh
```

- [x] **Step 7: Add npm scripts and run the tests**

```bash
npm pkg set "scripts.setup:gcp=bash scripts/setup-gcp.sh"
npm pkg set "scripts.lint:sh=shellcheck -x scripts/*.sh scripts/lib/*.sh"
npx vitest run test/scripts/setup-gcp.test.ts
```
Expected: 10 passed.

- [ ] (skipped: shellcheck not installed) **Step 8: shellcheck**

Run: `command -v shellcheck || brew install shellcheck; npm run lint:sh`
Expected: no output, exit 0. If shellcheck flags something, fix the script (don't add a blanket disable) and re-run Step 7.

- [ ] (user) **Step 9: Dry-run against the real project (read-only)**

Run: `bash scripts/setup-gcp.sh --dry-run`
Expected: `==>` progress lines on stderr, and `[dry-run] gcloud …` lines for everything that doesn't exist yet. Nothing is changed. (The real run happens in docs/setup.md Part 2, Task 3.)

- [x] **Step 10: Full suite and commit**

Run: `npm test && npm run typecheck`
Expected: all pass.
```bash
git add scripts/lib/common.sh scripts/setup-gcp.sh scripts/set-secret.sh test/helpers/fake-cli.ts \
  test/scripts/setup-gcp.test.ts package.json
git commit -m "feat(infra): idempotent setup-gcp.sh and set-secret.sh"
```

---

### Task 3: `docs/setup.md` part 2: GCP resources, Meta WhatsApp, local development

**Files:**
- Modify: `docs/setup.md` (append Part 2 and Part 3)
- Test: `test/infra/setup-doc.test.ts`

**Interfaces:**
- Consumes: `npm run setup:gcp`, `scripts/set-secret.sh` (Task 2); `docs/whatsapp-templates.md` (written by plan 03); `/jobs/tick?now=` when `DEV_SKIP_OIDC=true` (plan 04); `STORE=memory` (Task 5).
- Produces: the runbook sections that Tasks 6 and 7 link to: "Part 2", "Part 3: Local development".

- [x] **Step 1: Write the failing test**

`test/infra/setup-doc.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const doc = readFileSync("docs/setup.md", "utf8");

describe("docs/setup.md", () => {
  it("covers every Meta step the service depends on", () => {
    for (const needle of [
      "whatsapp_business_messaging", "whatsapp_business_management", "System user",
      "Verify token", "/webhooks/whatsapp", "messages", "docs/whatsapp-templates.md",
      "WA_PHONE_NUMBER_ID", "WA_APP_SECRET", "WA_ACCESS_TOKEN", "WA_VERIFY_TOKEN",
    ]) expect(doc, needle).toContain(needle);
  });
  it("has a local-dev runbook", () => {
    for (const needle of [
      "gcloud emulators firestore start --host-port=127.0.0.1:8085", "FIRESTORE_EMULATOR_HOST=127.0.0.1:8085",
      "cloudflared tunnel --url http://localhost:8080", "DEV_SKIP_OIDC=true", "/jobs/tick?now=",
    ]) expect(doc, needle).toContain(needle);
  });
  it("never shows a secret or phone number being typed on the command line", () => {
    expect(doc).not.toMatch(/versions add \S+ --data-file=- <<<|echo\s+"?sk-ant/);
    expect(doc).not.toMatch(/\b65\d{8}\b/);
  });
});
```

- [x] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/infra/setup-doc.test.ts`
Expected: FAIL on the missing `whatsapp_business_messaging` (and others).

- [x] **Step 3: Append Part 2 and Part 3 to `docs/setup.md`**

````markdown

## Part 2: Google Cloud resources and secrets

### 8. Create the cloud resources
```bash
npm run setup:gcp -- --dry-run   # shows what would be created
npm run setup:gcp                # idempotent; safe to re-run
```
This creates the Firestore Native DB (asia-southeast1), the `invoker@`/`runtime@` service accounts, Pub/Sub topic `gmail-push`
(with the publisher grant for `gmail-api-push@system.gserviceaccount.com`), the Cloud Tasks queue `inbound`, the 8 empty
secrets, and the IAM bindings.

### 9. Store the secrets (hidden prompt, never on the command line)
```bash
scripts/set-secret.sh ANTHROPIC_API_KEY
scripts/set-secret.sh GOOGLE_OAUTH_CLIENT_ID
scripts/set-secret.sh GOOGLE_OAUTH_CLIENT_SECRET
npm run auth -- personal        # default --to=auto: .env + Secret Manager
npm run auth -- school          # skip if Step 0 said school Gmail is blocked
```
The three WhatsApp secrets are set in steps 13–15 below.

## Part 2b: Meta WhatsApp Cloud API

### 10. Developer app
- [ ] https://developers.facebook.com → **My Apps** → **Create App** → use case **Connect with customers through WhatsApp**
  → pick or create a business portfolio → **Create app**.
- [ ] On the app's **WhatsApp → API Setup** page (Quickstart → "Start using the API"), Meta creates a **test phone number**
  and a test WhatsApp Business Account (WABA). Note the **Phone number ID** and the **WhatsApp Business Account ID**.
- [ ] Put `WA_PHONE_NUMBER_ID=<Phone number ID>` in `.env` (plain config, not a secret).

### 11. Allow your own number as a recipient
- [ ] API Setup → **To** → **Manage phone number list** → add your number (the one in `.env` as `MY_WHATSAPP_NUMBER`) →
  enter the code WhatsApp sends you. The test number can message up to 5 verified recipients, and needs no payment method.
- [ ] Click **Send message** to send the `hello_world` template to yourself. It should arrive on your phone within seconds.

### 12. App secret → `WA_APP_SECRET`
App Dashboard → **App settings → Basic** → **App secret** → Show. Then run `scripts/set-secret.sh WA_APP_SECRET` and paste it.
Webhook POSTs are signed with this secret (`X-Hub-Signature-256`).

### 13. Permanent access token → `WA_ACCESS_TOKEN`
The temporary token on API Setup expires after about 24h. Use a **System user** token instead:
- [ ] https://business.facebook.com → **Business settings** → **Users → System users** → **Add** (role Admin).
- [ ] **Assign assets**: the app (Full control: Manage app), and the WhatsApp account (Full control: Manage WhatsApp Business accounts).
- [ ] **Generate token** → select the app → expiration **Never** → permissions **whatsapp_business_messaging** and
  **whatsapp_business_management** (Meta's guide also lists `business_management`, so tick it too) → copy.
- [ ] `scripts/set-secret.sh WA_ACCESS_TOKEN` and paste. For local dev, also paste it into `.env` with an editor.

### 14. Verify token → `WA_VERIFY_TOKEN`
Generate a random string, store it, and keep it on screen for step 15:
```bash
openssl rand -hex 24
scripts/set-secret.sh WA_VERIFY_TOKEN     # paste the string printed above
```

### 15. Webhook (after the first deploy, or with a tunnel for local dev)
- [ ] App Dashboard → **WhatsApp → Configuration** → **Webhook** → **Edit**:
  - **Callback URL:** `https://<service URL>/webhooks/whatsapp` (`npm run deploy` prints it) or `https://<tunnel>/webhooks/whatsapp`.
  - **Verify token:** the string from step 14.
  - **Verify and save.** Meta calls `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`, and the
    service echoes the challenge.
- [ ] **Webhook fields** → **Manage** → subscribe to **messages**.
- [ ] Send "hi" from your phone to the test number. A `POST /webhooks/whatsapp` should show up in the logs.
- [ ] If nothing arrives: (1) check the app mode. Meta notes that some webhooks aren't sent in Development mode. Set a privacy
  policy URL under App settings → Basic and switch the app to **Live**. (2) Check the WABA is subscribed to the app:
  ```bash
  IFS= read -rs WA_TOKEN   # paste the system-user token; hidden, not in history
  curl -s -H "Authorization: Bearer $WA_TOKEN" "https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps"
  # empty "data": [] → subscribe it:
  curl -s -X POST -H "Authorization: Bearer $WA_TOKEN" "https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps"
  unset WA_TOKEN
  ```

### 16. Message templates
- [ ] WhatsApp Manager → **Message templates** → **Create template**. Create each template in `docs/whatsapp-templates.md`
  (`brief_ready`, `heads_up`), category **Utility**, language **English (en)**, quick-reply button as specified there.
- [ ] Wait for **Active** status. If Meta re-classifies a template as **Marketing**, reword it to be strictly
  informational about your own account activity and resubmit (spec §13.3).
- [ ] Templates made on the test number **don't carry over** to a real number. If you later register a spare SIM,
  submit them again.

## Part 3: Local development

### 17. One-time tools
```bash
brew install --cask temurin@21                      # the Firestore emulator needs Java 21+
gcloud components install cloud-firestore-emulator
brew install cloudflared
```

### 18. `.env` for local runs
These are the values to change from production. Everything else as in Parts 1–2:
```
NODE_ENV=development
DEV_SKIP_OIDC=true                         # no Google OIDC locally; the tasks queue runs inline
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085     # remove this line to talk to real Firestore
PUBLIC_BASE_URL=https://<random>.trycloudflare.com
```
`STORE=memory` skips Firestore entirely (data is lost on restart). Production refuses it.
`DEV_SKIP_OIDC=true` is refused when `NODE_ENV=production`.

### 19. Run it (three terminals)
```bash
# 1: Firestore emulator
gcloud emulators firestore start --host-port=127.0.0.1:8085
# 2: public tunnel for Meta's webhook. Copy the https://….trycloudflare.com URL into .env (PUBLIC_BASE_URL)
#    and into Meta (step 15 Callback URL + /webhooks/whatsapp). The URL changes every time you restart cloudflared.
cloudflared tunnel --url http://localhost:8080
# 3: the service
npm run dev
```

### 20. Drive time by hand
Pub/Sub can't push to your laptop, so new mail arrives through the tick's catch-up sync. Trigger a tick at any SGT time
(`?now=` only works with `DEV_SKIP_OIDC=true`; use UTC `Z` times so no URL encoding is needed):
```bash
curl -s -X POST "http://localhost:8080/jobs/tick"                                  # now
curl -s -X POST "http://localhost:8080/jobs/tick?now=2026-10-14T22:31:00Z"          # 06:31 SGT: morning brief
curl -s -X POST "http://localhost:8080/jobs/tick?now=2026-10-15T13:01:00Z"          # 21:01 SGT: evening check-in
```
When you're done, point the Meta callback URL back at the Cloud Run URL.
````

- [x] **Step 4: Run the test**

Run: `npx vitest run test/infra/setup-doc.test.ts`
Expected: 3 passed.

- [ ] (user) **Step 5: Do Part 2 for real (manual)**

Run docs/setup.md steps 8–14 and 16 (the webhook, step 15, needs the deploy in Task 6 or a tunnel).
Expected: `gcloud secrets versions list ANTHROPIC_API_KEY --limit=1` shows one `enabled` version for each secret you set.

- [x] **Step 6: Commit**

```bash
npm test && npm run typecheck
git add docs/setup.md test/infra/setup-doc.test.ts
git commit -m "docs: setup part 2 (GCP resources, Meta WhatsApp) and local-dev runbook"
```

---

### Task 4: `Dockerfile`, `.dockerignore`, `.gcloudignore`

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `.gcloudignore`
- Test: `test/infra/dockerfile.test.ts`

**Interfaces:**
- Consumes: npm scripts `build` (`tsc -p tsconfig.build.json` → `dist/`) from plan 00, and `src/main.ts` (Task 5, Phase B).
- Produces: an image that runs `node dist/main.js` as user `node` on `$PORT` (Cloud Run sets `PORT`, and plan 00's config reads it).

`gcloud run deploy --source .` uploads the files allowed by `.gcloudignore` (when it exists, it replaces the generated-from-`.gitignore` default). Cloud Build then builds with the `Dockerfile`. Two ignore files keep `.env` out at both stages.

- [x] **Step 1: Write the failing test**

`test/infra/dockerfile.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("container", () => {
  it("Dockerfile: multi-stage node:24-slim, npm ci, build, prune, non-root, starts dist/main.js", () => {
    const d = read("Dockerfile");
    expect(d).toMatch(/^FROM node:24-slim AS build$/m);
    expect(d).toMatch(/^FROM node:24-slim$/m);
    expect(d).toContain("RUN npm ci");
    expect(d).toContain("npm run build");
    expect(d).toContain("npm prune --omit=dev");
    expect(d).toMatch(/^USER node$/m);
    expect(d).toContain('CMD ["node", "dist/main.js"]');
    expect(d).not.toMatch(/COPY \. /);
  });

  it(".dockerignore keeps secrets, fixtures and bulk out of the build context", () => {
    const lines = read(".dockerignore").split("\n").map((l) => l.trim());
    for (const p of [".env", ".env.*", "node_modules", "docs", "evals/triage/fixtures", "evals/triage/labels.json", ".git"]) {
      expect(lines, p).toContain(p);
    }
    expect(lines).toContain("!.env.example");
  });

  it(".gcloudignore includes .gitignore (which ignores .env) so --source never uploads secrets", () => {
    expect(read(".gcloudignore").split("\n")[0]).toBe("#!include:.gitignore");
    expect(read(".gitignore").split("\n")).toContain(".env");
  });
});
```

- [x] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/infra/dockerfile.test.ts`
Expected: FAIL with ENOENT for `Dockerfile`.

- [x] **Step 3: Write `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

# ---- build: install all deps, compile TypeScript, then drop dev deps ----
FROM node:24-slim AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: only production deps + compiled JS, as the non-root "node" user ----
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
```

- [x] **Step 4: Write `.dockerignore` and `.gcloudignore`**

`.dockerignore`:
```
.env
.env.*
!.env.example
node_modules
dist
docs
test
evals/triage/fixtures
evals/triage/labels.json
.git
.gitignore
coverage
*.log
```

`.gcloudignore`:
```
#!include:.gitignore
.git
.gcloudignore
docs/
test/
evals/
coverage/
```

- [x] **Step 5: Run the test and check what `--source` would upload**

Run: `npx vitest run test/infra/dockerfile.test.ts`
Expected: 3 passed.

Run: `gcloud meta list-files-for-upload . | sort | grep -E '^(\.env|Dockerfile|package-lock\.json|src/)' | head`
Expected: `Dockerfile`, `package-lock.json` and `src/…` lines, and **no `.env` line**. (If gcloud prints `No module named 'grpc'`, it's a local gcloud install problem. Run `gcloud components reinstall` or follow the printed `CLOUDSDK_PYTHON_SITEPACKAGES` hint, then retry.)

- [ ] (skipped: Docker not installed) **Step 6: Build the image (optional, only if Docker or OrbStack is installed)**

Run: `docker build -t kiasu-assistant .`
Expected: the build succeeds. In Phase A, `dist/main.js` doesn't exist yet, so don't `docker run` until Task 5. If Docker isn't installed, skip this step. Cloud Build builds the same Dockerfile in Task 6.

- [x] **Step 7: Commit**

```bash
npm test && npm run typecheck
git add Dockerfile .dockerignore .gcloudignore test/infra/dockerfile.test.ts
git commit -m "feat(infra): multi-stage Dockerfile and ignore files"
```

---

# PHASE B: runs LAST, after plans 00–05 are merged into main

Before starting, check you're on an up-to-date `main` with every plan merged:
```bash
git log --oneline | head -20
ls src/gmail/sync.ts src/gmail/routes.ts src/calendar/service.ts src/classroom/service.ts \
   src/whatsapp/client.ts src/whatsapp/outbox.ts src/whatsapp/tasks.ts src/whatsapp/webhook.ts \
   src/notify/notifier.ts src/scheduler/routes.ts src/agent/agent.ts src/agent/routes.ts
npm test && npm run typecheck
```
Expected: all 12 files listed, and tests and typecheck pass. If a file is missing, stop: that plan isn't merged.

---

### Task 5: Composition root: `src/app.ts` and `src/main.ts`

**Files:**
- Create: `src/app.ts`, `src/main.ts`
- Modify: `.env.example` (append the `STORE` comment)
- Test: `test/main.test.ts`

**Interfaces:**
- Consumes (exact factory names from the sibling plans):
  - plan 01: `createMailService(deps: Pick<Deps,"config"|"clock"|"log"|"store"|"anthropic"|"outbox">)` from `src/gmail/sync.ts`; `registerGmailRoutes` from `src/gmail/routes.ts`
  - plan 02: `createCalendarService(deps: Pick<Deps,"config"|"log"|"store">)` from `src/calendar/service.ts`; `createClassroomService(deps: Pick<Deps,"config"|"clock"|"log"|"store"|"anthropic">)` from `src/classroom/service.ts`
  - plan 03: `createWhatsAppClient(config)` from `src/whatsapp/client.ts`; `createOutbox(deps: Pick<Deps,"clock"|"log"|"store"|"whatsapp">)` from `src/whatsapp/outbox.ts`; `createCloudTaskQueue(config, client?)` and `createInlineTaskQueue(handle: (msg: InboundMessage) => Promise<void>, log?: Logger)` (runs `handle` on `setImmediate`; pass `log` so handler errors show in dev) from `src/whatsapp/tasks.ts`; `registerWhatsAppRoutes` from `src/whatsapp/webhook.ts`
  - plan 04: `createNotifier(deps: Pick<Deps,"clock"|"log"|"store"|"outbox">)` from `src/notify/notifier.ts`; `registerJobRoutes` from `src/scheduler/routes.ts`
  - plan 05: `createChatAgent(deps: Pick<Deps,"config"|"clock"|"log"|"store"|"anthropic"|"mail"|"calendar">)` from `src/agent/agent.ts`; `registerTaskRoutes` from `src/agent/routes.ts`
  - plan 00: `loadConfig`, `systemClock`, `createLogger`, `MemoryStore`, `FirestoreStore`, `createFirestore`, `buildServer`, `RouteRegistrar`, `Deps`.
- Produces (`src/app.ts`):
  - `REGISTRARS: RouteRegistrar[]` = `[registerGmailRoutes, registerWhatsAppRoutes, registerJobRoutes, registerTaskRoutes]`
  - `type StoreKind = "firestore" | "memory"`; `chooseStoreKind(config: Pick<Config, "NODE_ENV">, env: Record<string, string | undefined>): StoreKind`
  - `interface BuildOptions { env?: Record<string, string | undefined>; overrides?: Partial<Omit<Deps, "config">> }`
  - `buildDeps(config: Config, opts?: BuildOptions): { deps: Deps; bindApp(app: FastifyInstance): void }`
  - `buildApp(config: Config, opts?: BuildOptions): Promise<{ app: FastifyInstance; deps: Deps }>`
- `src/main.ts` exports nothing. It loads config, calls `buildApp`, listens on `0.0.0.0:PORT`, and handles SIGTERM/SIGINT.

Build order (no cycles): config → clock → log → store → anthropic → whatsapp → outbox → notifier → mail → calendar → classroom → agent → tasks → `buildServer`. In dev (`DEV_SKIP_OIDC=true`) the inline task queue `app.inject`s `POST /tasks/handle-message`. It runs exactly the route Cloud Tasks would call, so dev and prod share one code path. The app reference is bound after `buildServer` returns.

- [x] **Step 1: Write the failing test**

`test/main.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { buildApp, chooseStoreKind, type BuildOptions } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { FakeClock } from "../src/lib/clock.js";
import { silentLogger } from "../src/lib/log.js";
import { MemoryStore } from "../src/store/memory.js";
import type { ChatAgent, WhatsAppClient } from "../src/ports.js";
import type { InboundMessage } from "../src/types.js";
import { TEST_ENV } from "./helpers/env.js";

// No test may reach the network: Graph API, Google and Anthropic all go through this.
const fakeFetch = vi.fn(async () =>
  new Response(JSON.stringify({ messages: [{ id: "wamid.fake" }] }), { status: 200, headers: { "content-type": "application/json" } }));

async function build(env: Record<string, string> = {}, overrides: BuildOptions["overrides"] = {}) {
  const config = loadConfig({ ...TEST_ENV, ...env });
  return buildApp(config, {
    env: { STORE: "memory" },
    overrides: {
      clock: new FakeClock("2026-10-14T00:00:00Z"),
      log: silentLogger,
      anthropic: new Anthropic({ apiKey: "test-key", maxRetries: 0, fetch: fakeFetch as unknown as typeof fetch }),
      ...overrides,
    },
  });
}

beforeEach(() => {
  fakeFetch.mockClear();
  vi.stubGlobal("fetch", fakeFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("composition root", () => {
  it("registers every route from spec §4", async () => {
    const { app } = await build();
    for (const [method, url] of [
      ["GET", "/healthz"],
      ["GET", "/webhooks/whatsapp"],
      ["POST", "/webhooks/whatsapp"],
      ["POST", "/webhooks/gmail"],
      ["POST", "/jobs/tick"],
      ["POST", "/tasks/handle-message"],
    ] as const) {
      expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }
    expect((await app.inject("/healthz")).json()).toEqual({ ok: true });
    await app.close();
  });

  it("Google-called routes reject requests without OIDC", async () => {
    const { app } = await build();
    for (const url of ["/webhooks/gmail", "/jobs/tick", "/tasks/handle-message"]) {
      const res = await app.inject({ method: "POST", url, payload: {} });
      expect(res.statusCode, url).toBe(401);
    }
    await app.close();
  });

  it("WhatsApp: verification handshake echoes the challenge; bad signatures are rejected", async () => {
    const { app } = await build();
    const ok = await app.inject({
      method: "GET",
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TEST_ENV.WA_VERIFY_TOKEN}&hub.challenge=4242`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("4242");
    const wrong = await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1" });
    expect(wrong.statusCode).not.toBe(200);
    const forged = await app.inject({
      method: "POST", url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
      payload: { object: "whatsapp_business_account", entry: [] },
    });
    expect([401, 403]).toContain(forged.statusCode);
    await app.close();
  });

  it("uses MemoryStore when STORE=memory", async () => {
    const { app, deps } = await build();
    expect(deps.store).toBeInstanceOf(MemoryStore);
    await app.close();
  });

  it("with DEV_SKIP_OIDC the inline task queue runs /tasks/handle-message (same path as Cloud Tasks)", async () => {
    const agent: ChatAgent = { reply: vi.fn(async () => "pong") };
    const whatsapp: WhatsAppClient = {
      sendText: vi.fn(async () => ({ messageId: "w1" })),
      sendTemplate: vi.fn(async () => ({ messageId: "w2" })),
    };
    const { app, deps } = await build({ DEV_SKIP_OIDC: "true" }, { agent, whatsapp });
    const msg: InboundMessage = {
      id: "wamid.inline1", from: TEST_ENV.MY_WHATSAPP_NUMBER!, timestamp: "2026-10-14T00:00:00.000Z",
      type: "text", text: "ping", contextMessageId: null,
    };
    await deps.tasks.enqueueInbound(msg);
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledWith("ping"));
    await app.close();
  });
});

describe("chooseStoreKind", () => {
  it("defaults to firestore, allows memory outside production, rejects nonsense", () => {
    expect(chooseStoreKind({ NODE_ENV: "development" }, {})).toBe("firestore");
    expect(chooseStoreKind({ NODE_ENV: "development" }, { STORE: "firestore" })).toBe("firestore");
    expect(chooseStoreKind({ NODE_ENV: "development" }, { STORE: "memory" })).toBe("memory");
    expect(() => chooseStoreKind({ NODE_ENV: "production" }, { STORE: "memory" })).toThrow(/not allowed in production/);
    expect(() => chooseStoreKind({ NODE_ENV: "development" }, { STORE: "redis" })).toThrow(/STORE must be/);
  });
});
```

- [x] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/main.test.ts`
Expected: FAIL with "Cannot find module '../src/app.js'".

- [x] **Step 3: Implement `src/app.ts`**

```ts
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
```

- [x] **Step 4: Implement `src/main.ts`**

```ts
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

/** Cloud Run sends SIGTERM and waits 10s before SIGKILL. */
const SHUTDOWN_GRACE_MS = 8_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, deps } = await buildApp(config);
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  deps.log.info("listening", { port: config.PORT, nodeEnv: config.NODE_ENV, devSkipOidc: config.DEV_SKIP_OIDC });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    deps.log.info("shutting down", { signal });
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        deps.log.error("shutdown failed", { err });
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // Config errors list variable names only, never values.
  console.error(JSON.stringify({ severity: "ERROR", message: "startup failed", error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
```

- [x] **Step 5: Document `STORE` in `.env.example`**

Run:
```bash
printf '\n# Local only. memory = no Firestore, data lost on restart (refused when NODE_ENV=production)\n# STORE=memory\n' >> .env.example
tail -3 .env.example
```
Expected: the two new comment lines.

- [x] **Step 6: Run the tests**

Run: `npx vitest run test/main.test.ts && npm run typecheck`
Expected: 6 passed, and typecheck exits 0. If typecheck reports a factory signature mismatch, the sibling plan's actual export wins: fix the call here (the names are fixed, the `Pick<…>` sets are listed above). Don't edit the sibling module.

- [x] **Step 7: Run the real entry point locally and check SIGTERM**

Run (needs a filled-in `.env`; `STORE=memory` keeps it off Firestore):
```bash
npm run build
STORE=memory DEV_SKIP_OIDC=true NODE_ENV=development node --env-file=.env dist/main.js & PID=$!
sleep 2; curl -s localhost:8080/healthz; echo
kill -TERM $PID; wait $PID; echo "exit=$?"
```
Expected: a JSON `"listening"` log line, then `{"ok":true}`, then a `"shutting down"` log line with `"signal":"SIGTERM"`, then `exit=0`.

- [x] **Step 8: Full suite and commit**

Run: `npm test && npm run typecheck`
Expected: all pass.
```bash
git add src/app.ts src/main.ts test/main.test.ts .env.example
git commit -m "feat: composition root (buildDeps/buildApp) and main entry point"
```

---

### Task 6: `scripts/deploy.sh`, Cloud Run env rendering, `npm run gmail:watch`

**Files:**
- Create: `scripts/lib/deploy-env.ts`, `scripts/render-run-env.ts`, `scripts/deploy.sh`, `scripts/lib/watch.ts`, `scripts/gmail-watch.ts`
- Modify: `package.json` (scripts `deploy`, `gmail:watch`), `docs/setup.md` (append Part 4)
- Test: `test/scripts/deploy-env.test.ts`, `test/scripts/deploy.test.ts`, `test/scripts/watch.test.ts`

**Interfaces:**
- Consumes: `scripts/lib/common.sh` and `runWithFakeCli` (Task 2); `buildDeps` (Task 5); `ALL_SECRET_KEYS`, `fillFromSecretManager`, `projectFromEnv` (Task 1); `googleAuthFor`, `isInvalidGrant` (plan 00); `MailService.renewWatchIfNeeded(account)` (plan 01).
- Produces:
  - `scripts/lib/deploy-env.ts`: `COPIED_KEYS`, `normaliseBaseUrl(url): string`, `buildRunEnv(dotenv, { publicBaseUrl, project, region }): Record<string, string>`, `toEnvYaml(env): string`
  - `scripts/lib/watch.ts`: `watchErrorHint(err: unknown, topic: string): string | null`
  - npm scripts `deploy` and `gmail:watch`.

How `deploy.sh` avoids the "first deploy before `PUBLIC_BASE_URL` is known" trap: Cloud Run gives each service a deterministic URL, `https://kiasu-assistant-<PROJECT_NUMBER>.asia-southeast1.run.app`. The script uses it (or the existing service's `status.url`) as `PUBLIC_BASE_URL` for the deploy. Afterwards it re-reads `status.url`. If that differs, it runs `gcloud run services update --update-env-vars=PUBLIC_BASE_URL=<real>` and wires Pub/Sub and Scheduler to the real URL. **No manual second deploy is needed.** The local `.env`'s `PUBLIC_BASE_URL` (the tunnel URL) is never sent to Cloud Run.

- [x] **Step 1: Write the failing tests**

`test/scripts/deploy-env.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildRunEnv, normaliseBaseUrl, toEnvYaml } from "../../scripts/lib/deploy-env.js";

const opts = { publicBaseUrl: "https://kiasu-assistant-1.asia-southeast1.run.app/", project: "demo-proj", region: "asia-southeast1" };
const dotenv = {
  ANTHROPIC_API_KEY: "sk-leak", WA_ACCESS_TOKEN: "wa-leak", PORT: "8080", DEV_SKIP_OIDC: "true", NODE_ENV: "development",
  PUBLIC_BASE_URL: "https://tunnel.trycloudflare.com", GMAIL_PUBSUB_TOPIC: "projects/your-gcp-project/topics/gmail-push",
  WA_PHONE_NUMBER_ID: "111", MY_WHATSAPP_NUMBER: "6500000000", CLASSROOM_ENABLED: "false", TRIAGE_MODEL: "claude-haiku-5-5",
};

describe("buildRunEnv", () => {
  it("keeps only plain config, forces production values, derives resource names from the project", () => {
    expect(buildRunEnv(dotenv, opts)).toEqual({
      NODE_ENV: "production",
      DEV_SKIP_OIDC: "false",
      PUBLIC_BASE_URL: "https://kiasu-assistant-1.asia-southeast1.run.app",
      GCP_PROJECT: "demo-proj",
      GCP_REGION: "asia-southeast1",
      GMAIL_PUBSUB_TOPIC: "projects/demo-proj/topics/gmail-push",
      INVOKER_SERVICE_ACCOUNT: "invoker@demo-proj.iam.gserviceaccount.com",
      TASKS_QUEUE: "projects/demo-proj/locations/asia-southeast1/queues/inbound",
      TRIAGE_MODEL: "claude-haiku-5-5",
      WA_PHONE_NUMBER_ID: "111",
      MY_WHATSAPP_NUMBER: "6500000000",
      CLASSROOM_ENABLED: "false",
    });
  });
  it("requires WA_PHONE_NUMBER_ID and a digits-only MY_WHATSAPP_NUMBER", () => {
    expect(() => buildRunEnv({ ...dotenv, WA_PHONE_NUMBER_ID: "" }, opts)).toThrow(/WA_PHONE_NUMBER_ID/);
    expect(() => buildRunEnv({ ...dotenv, MY_WHATSAPP_NUMBER: "+65 8000 0000" }, opts)).toThrow(/MY_WHATSAPP_NUMBER/);
  });
  it("normalises trailing slashes and writes YAML-safe quoted values", () => {
    expect(normaliseBaseUrl(" https://x.run.app/// ")).toBe("https://x.run.app");
    expect(toEnvYaml({ A: "1", B: 'say "hi": yes' })).toBe('A: "1"\nB: "say \\"hi\\": yes"\n');
  });
});
```

`test/scripts/deploy.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithFakeCli } from "../helpers/fake-cli.js";

const REQUIRED = "ANTHROPIC_API_KEY GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET WA_ACCESS_TOKEN WA_APP_SECRET WA_VERIFY_TOKEN";
const DET_URL = "https://kiasu-assistant-123456789.asia-southeast1.run.app";

function envFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), "deploy-env-")), ".env");
  writeFileSync(file, [
    "GCP_PROJECT=demo-proj",
    "PORT=8080",
    "PUBLIC_BASE_URL=https://example.trycloudflare.com/",
    "ANTHROPIC_API_KEY=sk-should-not-leak",
    "WA_ACCESS_TOKEN=wa-should-not-leak",
    "WA_PHONE_NUMBER_ID=111222333",
    "MY_WHATSAPP_NUMBER=6500000000",
    "DEV_SKIP_OIDC=true",
    "CLASSROOM_ENABLED=false",
  ].join("\n"));
  return file;
}

function deploy(extra: Record<string, string> = {}) {
  return runWithFakeCli("scripts/deploy.sh", ["--skip-watch"], {
    GCP_PROJECT: "demo-proj", GCP_REGION: "asia-southeast1", ENV_FILE: envFile(),
    FAKE_SECRETS: `${REQUIRED} GOOGLE_REFRESH_TOKEN_PERSONAL`, FAKE_URL: DET_URL, ...extra,
  });
}

const line = (log: string[], prefix: string) => log.find((l) => l.startsWith(prefix)) ?? "";

describe("deploy.sh", () => {
  it("deploys with secrets from Secret Manager and plain env from .env (no secrets, no PORT)", () => {
    const r = deploy();
    expect(r.status, r.stderr).toBe(0);
    const d = line(r.log, "gcloud run deploy kiasu-assistant");
    expect(d).toContain("--source . --region=asia-southeast1");
    expect(d).toContain("--service-account=runtime@demo-proj.iam.gserviceaccount.com");
    expect(d).toContain("--allow-unauthenticated");
    expect(d).toContain("--max-instances=1"); // plan 01's sync lock is per process
    expect(d).toContain("ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest");
    expect(d).toContain("GOOGLE_REFRESH_TOKEN_PERSONAL=GOOGLE_REFRESH_TOKEN_PERSONAL:latest");
    expect(d).not.toContain("GOOGLE_REFRESH_TOKEN_SCHOOL");
    const yaml = readFileSync(join(r.dir, "env.yaml"), "utf8");
    expect(yaml).toContain(`PUBLIC_BASE_URL: "${DET_URL}"`);
    expect(yaml).toContain(`NODE_ENV: "production"`);
    expect(yaml).toContain(`DEV_SKIP_OIDC: "false"`);
    expect(yaml).toContain(`CLASSROOM_ENABLED: "false"`);
    expect(yaml).not.toMatch(/should-not-leak|^PORT:/m);
  });

  it("OIDC audiences equal PUBLIC_BASE_URL + path exactly (no double slash)", () => {
    const r = deploy();
    const sub = line(r.log, "gcloud pubsub subscriptions create gmail-push-sub");
    expect(sub).toContain("--topic=gmail-push");
    expect(sub).toContain(`--push-endpoint=${DET_URL}/webhooks/gmail`);
    expect(sub).toContain(`--push-auth-token-audience=${DET_URL}/webhooks/gmail`);
    expect(sub).toContain("--push-auth-service-account=invoker@demo-proj.iam.gserviceaccount.com");
    const job = line(r.log, "gcloud scheduler jobs create http tick");
    expect(job).toContain("--schedule=*/5 * * * *");
    expect(job).toContain("--time-zone=Asia/Singapore");
    expect(job).toContain(`--uri=${DET_URL}/jobs/tick`);
    expect(job).toContain(`--oidc-token-audience=${DET_URL}/jobs/tick`);
    expect(job).toContain("--oidc-service-account-email=invoker@demo-proj.iam.gserviceaccount.com");
    expect(r.log.join("\n")).not.toContain("run.app//");
  });

  it("when the real URL differs from the predicted one, fixes PUBLIC_BASE_URL and wires that URL", () => {
    const r = deploy({ FAKE_URL: "https://kiasu-assistant-abc123xyz-as.a.run.app/" });
    expect(r.status, r.stderr).toBe(0);
    expect(line(r.log, "gcloud run services update kiasu-assistant")).toContain(
      "--update-env-vars=PUBLIC_BASE_URL=https://kiasu-assistant-abc123xyz-as.a.run.app");
    expect(line(r.log, "gcloud pubsub subscriptions create")).toContain(
      "--push-auth-token-audience=https://kiasu-assistant-abc123xyz-as.a.run.app/webhooks/gmail");
  });

  it("updates (not recreates) the subscription and job when they exist", () => {
    const r = deploy({ FAKE_EXISTS: "true" });
    expect(line(r.log, "gcloud pubsub subscriptions update gmail-push-sub")).not.toBe("");
    expect(line(r.log, "gcloud scheduler jobs update http tick")).not.toBe("");
    expect(r.log.some((l) => l.includes("subscriptions create") || l.includes("jobs create"))).toBe(false);
  });

  it("refuses to deploy when a required secret has no value", () => {
    const r = deploy({ FAKE_SECRETS: "ANTHROPIC_API_KEY" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("WA_APP_SECRET");
    expect(r.log.some((l) => l.startsWith("gcloud run deploy"))).toBe(false);
  });

  it("runs gmail:watch unless --skip-watch", () => {
    const r = runWithFakeCli("scripts/deploy.sh", [], {
      GCP_PROJECT: "demo-proj", ENV_FILE: envFile(), FAKE_SECRETS: REQUIRED, FAKE_URL: DET_URL,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.log).toContain("npm run --silent gmail:watch");
  });
});
```

`test/scripts/watch.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { watchErrorHint } from "../../scripts/lib/watch.js";

const TOPIC = "projects/demo-proj/topics/gmail-push";

describe("watchErrorHint", () => {
  it("watchErrorHint explains a missing publisher grant", () => {
    const h = watchErrorHint(new Error(`Error sending test message to Cloud PubSub ${TOPIC} : User not authorized to perform this action.`), TOPIC);
    expect(h).toContain("gmail-api-push@system.gserviceaccount.com");
    expect(h).toContain("npm run setup:gcp");
  });
  it("explains a missing or misnamed topic", () => {
    expect(watchErrorHint(new Error("Invalid topicName does not match projects/demo-proj/topics/*"), TOPIC)).toContain(TOPIC);
    expect(watchErrorHint(new Error("Resource not found (resource=gmail-push)."), TOPIC)).toContain("npm run setup:gcp");
  });
  it("explains a revoked token", () => {
    expect(watchErrorHint({ response: { data: { error: "invalid_grant" } } }, TOPIC)).toContain("npm run auth");
  });
  it("returns null for anything else", () => {
    expect(watchErrorHint(new Error("socket hang up"), TOPIC)).toBeNull();
  });
});
```

- [x] **Step 2: Run them to confirm they fail**

Run: `npx vitest run test/scripts/deploy-env.test.ts test/scripts/deploy.test.ts test/scripts/watch.test.ts`
Expected: FAIL. The modules aren't found, and `scripts/deploy.sh` is missing (exit 127).

- [x] **Step 3: Implement `scripts/lib/deploy-env.ts` and `scripts/render-run-env.ts`**

`scripts/lib/deploy-env.ts`:
```ts
/** Builds the plain (non-secret) env vars for Cloud Run from the local .env. */

/** Copied from .env when present. Everything else in .env (secrets, PORT, dev flags, local URLs) is ignored. */
export const COPIED_KEYS = [
  "TRIAGE_MODEL",
  "CHAT_MODEL",
  "WA_PHONE_NUMBER_ID",
  "WA_GRAPH_VERSION",
  "MY_WHATSAPP_NUMBER",
  "CLASSROOM_ENABLED",
] as const;

export interface RunEnvOptions {
  publicBaseUrl: string;
  project: string;
  region: string;
}

export function normaliseBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function buildRunEnv(dotenv: Record<string, string | undefined>, opts: RunEnvOptions): Record<string, string> {
  const { project, region } = opts;
  const out: Record<string, string> = {
    NODE_ENV: "production",
    DEV_SKIP_OIDC: "false",
    PUBLIC_BASE_URL: normaliseBaseUrl(opts.publicBaseUrl),
    GCP_PROJECT: project,
    GCP_REGION: region,
    // Derived from the project so they always match what setup-gcp.sh created.
    GMAIL_PUBSUB_TOPIC: `projects/${project}/topics/gmail-push`,
    INVOKER_SERVICE_ACCOUNT: `invoker@${project}.iam.gserviceaccount.com`,
    TASKS_QUEUE: `projects/${project}/locations/${region}/queues/inbound`,
  };
  for (const key of COPIED_KEYS) {
    const value = dotenv[key]?.trim();
    if (value) out[key] = value;
  }
  if (!out.WA_PHONE_NUMBER_ID) throw new Error("WA_PHONE_NUMBER_ID is missing from .env");
  if (!out.MY_WHATSAPP_NUMBER || !/^\d{8,15}$/.test(out.MY_WHATSAPP_NUMBER)) {
    throw new Error("MY_WHATSAPP_NUMBER in .env must be digits only, with country code");
  }
  return out;
}

/** YAML for `gcloud run deploy --env-vars-file`. JSON strings are valid YAML double-quoted scalars. */
export function toEnvYaml(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n";
}
```

`scripts/render-run-env.ts`:
```ts
/**
 * Writes the Cloud Run env-vars YAML used by scripts/deploy.sh. Prints key names only.
 * Usage: tsx scripts/render-run-env.ts --env-file=.env --public-base-url=URL --project=P --region=R --out=FILE
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { buildRunEnv, toEnvYaml } from "./lib/deploy-env.js";

function arg(name: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  if (!hit) throw new Error(`Missing ${prefix}…`);
  return hit.slice(prefix.length);
}

const dotenv = parseEnv(readFileSync(arg("env-file"), "utf8"));
const env = buildRunEnv(dotenv, { publicBaseUrl: arg("public-base-url"), project: arg("project"), region: arg("region") });
writeFileSync(arg("out"), toEnvYaml(env), { mode: 0o600 });
console.error(`Plain env vars for Cloud Run (no secrets): ${Object.keys(env).join(", ")}`);
```

- [x] **Step 4: Implement `scripts/deploy.sh`**

```bash
#!/usr/bin/env bash
# Builds and deploys kiasu-assistant to Cloud Run, then points Gmail push (Pub/Sub) and the
# 5-minute tick (Cloud Scheduler) at the service URL, with OIDC tokens signed as invoker@.
#
# Usage:  scripts/deploy.sh [--dry-run] [--skip-watch]
# Needs:  scripts/setup-gcp.sh run once, every required secret set (scripts/set-secret.sh NAME),
#         and WA_PHONE_NUMBER_ID + MY_WHATSAPP_NUMBER in .env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/common.sh
source scripts/lib/common.sh

SKIP_WATCH=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --skip-watch) SKIP_WATCH=true ;;
    -h | --help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

load_project_env
ENV_FILE="${ENV_FILE:-.env}"
if [[ ! -f "$ENV_FILE" ]]; then die "$ENV_FILE not found (copy .env.example and fill it in)"; fi

PROJECT_NUMBER="$(project_number)" || die "Could not read the project number for $GCP_PROJECT"

service_url() {
  gcloud run services describe "$SERVICE_NAME" --region="$GCP_REGION" --format='value(status.url)' 2>/dev/null
}

# PUBLIC_BASE_URL is also the base of every OIDC audience, so it must be right on the FIRST deploy.
# Cloud Run's deterministic URL is predictable. After deploying we re-read the real one.
URL="$(service_url || true)"
if [[ -z "$URL" ]]; then URL="https://${SERVICE_NAME}-${PROJECT_NUMBER}.${GCP_REGION}.run.app"; fi
URL="${URL%/}"

log "Checking that secrets have a value"
has_version() {
  [[ -n "$(gcloud secrets versions list "$1" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null || true)" ]]
}
SECRET_PAIRS=()
MISSING=()
for s in "${REQUIRED_SECRETS[@]}"; do
  if has_version "$s"; then SECRET_PAIRS+=("${s}=${s}:latest"); else MISSING+=("$s"); fi
done
if [[ "${#MISSING[@]}" -gt 0 ]]; then
  die "These secrets have no value yet: ${MISSING[*]}. Set each with: scripts/set-secret.sh NAME"
fi
for s in "${OPTIONAL_SECRETS[@]}"; do
  if has_version "$s"; then
    SECRET_PAIRS+=("${s}=${s}:latest")
  else
    warn "$s has no value; that Google account will be skipped (run: npm run auth -- personal|school)"
  fi
done
SECRETS_ARG="$(IFS=,; printf '%s' "${SECRET_PAIRS[*]}")"

ENV_YAML="$(mktemp -t kiasu-run-env.XXXXXX)"
trap 'rm -f "$ENV_YAML"' EXIT
"$ROOT/node_modules/.bin/tsx" scripts/render-run-env.ts \
  --env-file="$ENV_FILE" --public-base-url="$URL" --project="$GCP_PROJECT" --region="$GCP_REGION" --out="$ENV_YAML"

log "Deploying $SERVICE_NAME to $GCP_REGION from source (Cloud Build, ~3-5 min)"
run gcloud run deploy "$SERVICE_NAME" --source . --region="$GCP_REGION" \
  --service-account="$RUNTIME_SA" --allow-unauthenticated \
  --env-vars-file="$ENV_YAML" --set-secrets="$SECRETS_ARG" \
  --memory=512Mi --timeout=300 --min-instances=0 --max-instances=1 --quiet

ACTUAL="$URL"
if [[ "$DRY_RUN" != "true" ]]; then
  ACTUAL="$(service_url || true)"
  ACTUAL="${ACTUAL%/}"
  if [[ -z "$ACTUAL" ]]; then die "Deployed, but could not read the service URL"; fi
fi
if [[ "$ACTUAL" != "$URL" ]]; then
  log "Service URL is $ACTUAL (predicted $URL); updating PUBLIC_BASE_URL to match"
  run gcloud run services update "$SERVICE_NAME" --region="$GCP_REGION" \
    --update-env-vars="PUBLIC_BASE_URL=${ACTUAL}" --quiet
  URL="$ACTUAL"
fi

GMAIL_ENDPOINT="${URL}/webhooks/gmail"
log "Pub/Sub push subscription $SUBSCRIPTION -> $GMAIL_ENDPOINT"
SUB_FLAGS=(--push-endpoint="$GMAIL_ENDPOINT" --push-auth-service-account="$INVOKER_SA"
  --push-auth-token-audience="$GMAIL_ENDPOINT" --ack-deadline=60)
if exists gcloud pubsub subscriptions describe "$SUBSCRIPTION"; then
  run gcloud pubsub subscriptions update "$SUBSCRIPTION" "${SUB_FLAGS[@]}"
else
  run gcloud pubsub subscriptions create "$SUBSCRIPTION" --topic="$TOPIC" "${SUB_FLAGS[@]}"
fi

TICK_URL="${URL}/jobs/tick"
log "Cloud Scheduler job $SCHEDULER_JOB -> $TICK_URL every 5 min (Asia/Singapore)"
JOB_FLAGS=(--location="$GCP_REGION" --schedule='*/5 * * * *' --time-zone=Asia/Singapore
  --uri="$TICK_URL" --http-method=post --oidc-service-account-email="$INVOKER_SA"
  --oidc-token-audience="$TICK_URL" --attempt-deadline=300s)
if exists gcloud scheduler jobs describe "$SCHEDULER_JOB" --location="$GCP_REGION"; then
  run gcloud scheduler jobs update http "$SCHEDULER_JOB" "${JOB_FLAGS[@]}"
else
  run gcloud scheduler jobs create http "$SCHEDULER_JOB" "${JOB_FLAGS[@]}"
fi

log "Health check"
run curl -fsS "${URL}/healthz"
echo

if [[ "$SKIP_WATCH" != "true" ]]; then
  log "Starting or renewing the Gmail watch for both accounts"
  run npm run --silent gmail:watch
fi

cat >&2 <<EOF

Deployed: ${URL}
  - Cloud Run's PUBLIC_BASE_URL is ${URL} (your local .env keeps its own value for local dev).
  - Meta webhook Callback URL (WhatsApp > Configuration): ${URL}/webhooks/whatsapp
  - Logs: gcloud run services logs read ${SERVICE_NAME} --region=${GCP_REGION} --limit=50
EOF
```

Run: `chmod +x scripts/deploy.sh`

- [x] **Step 5: Implement `scripts/lib/watch.ts` and `scripts/gmail-watch.ts`**

`scripts/lib/watch.ts`:
```ts
import { isInvalidGrant } from "../../src/google/auth.js";

/** A human hint for the common users.watch failures (spec §13.4), or null. */
export function watchErrorHint(err: unknown, topic: string): string | null {
  if (isInvalidGrant(err)) return "The refresh token was rejected. Run: npm run auth -- personal|school";
  const message = err instanceof Error ? err.message : JSON.stringify(err);
  if (/not authorized|permission/i.test(message)) {
    return (
      `Gmail can't publish to ${topic}. Grant roles/pubsub.publisher on the topic to ` +
      "gmail-api-push@system.gserviceaccount.com: run npm run setup:gcp (it's idempotent)."
    );
  }
  if (/invalid topicname|not found|does not exist/i.test(message)) {
    return `Topic ${topic} doesn't exist or GMAIL_PUBSUB_TOPIC is wrong. Run npm run setup:gcp and redeploy.`;
  }
  return null;
}
```

`scripts/gmail-watch.ts`:
```ts
/**
 * Starts or renews the Gmail push watch for both accounts against PRODUCTION Firestore (spec §13.4).
 * Usage: npm run gmail:watch  (deploy.sh runs it). Needs `gcloud auth application-default login`.
 * Missing values in .env are filled from Secret Manager. Use --emulator to target FIRESTORE_EMULATOR_HOST instead.
 */
import { loadConfig } from "../src/config.js";
import { buildDeps } from "../src/app.js";
import { googleAuthFor } from "../src/google/auth.js";
import { ACCOUNT_IDS } from "../src/types.js";
import { ALL_SECRET_KEYS, fillFromSecretManager, projectFromEnv } from "./lib/secrets.js";
import { watchErrorHint } from "./lib/watch.js";

async function main(): Promise<number> {
  const useEmulator = process.argv.includes("--emulator");
  if (process.env.FIRESTORE_EMULATOR_HOST && !useEmulator) {
    console.error("FIRESTORE_EMULATOR_HOST is set, so the watch state would go to the emulator. Unset it, or pass --emulator.");
    return 1;
  }
  const filled = await fillFromSecretManager(process.env, ALL_SECRET_KEYS, projectFromEnv(process.env));
  if (filled.length > 0) console.log(`Filled from Secret Manager: ${filled.join(", ")}`);
  const config = loadConfig({ ...process.env, NODE_ENV: "development", DEV_SKIP_OIDC: "false" });
  const { deps } = buildDeps(config, { env: { STORE: "firestore" } });

  let failures = 0;
  for (const account of ACCOUNT_IDS) {
    if (!googleAuthFor(account, config)) {
      console.log(`- ${account}: no refresh token, skipped (npm run auth -- ${account})`);
      continue;
    }
    try {
      await deps.mail.renewWatchIfNeeded(account);
      const state = await deps.store.accounts.get(account);
      console.log(`✅ ${account}: watch expires ${state?.watchExpiresAt ?? "(unknown)"}`);
    } catch (err) {
      failures++;
      console.log(`❌ ${account}: ${err instanceof Error ? err.message : String(err)}`);
      const hint = watchErrorHint(err, config.GMAIL_PUBSUB_TOPIC);
      if (hint) console.log(`   ${hint}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
```
(`process.exit` because the Firestore client keeps sockets open.)

- [x] **Step 6: Add the npm scripts and run the tests** (13 passed; `lint:sh` skipped: shellcheck not installed)

```bash
npm pkg set "scripts.deploy=bash scripts/deploy.sh"
npm pkg set "scripts.gmail:watch=tsx --env-file=.env scripts/gmail-watch.ts"
npx vitest run test/scripts/deploy-env.test.ts test/scripts/deploy.test.ts test/scripts/watch.test.ts
npm run lint:sh
```
Expected: 3 + 6 + 4 = 13 passed, and shellcheck prints nothing.

- [x] **Step 7: Append Part 4 (deploy) to `docs/setup.md`**

````markdown

## Part 4: Deploy

### 21. Deploy
```bash
npm run deploy -- --dry-run    # prints every mutating command, changes nothing
npm run deploy
```
The script checks every required secret has a value, builds from source with Cloud Build, deploys `kiasu-assistant`
(`runtime@`, unauthenticated, secrets from Secret Manager, plain config from `.env`), sets `PUBLIC_BASE_URL` to the
service URL, creates or updates the Pub/Sub push subscription and the `tick` scheduler job (both OIDC as `invoker@`,
audience = URL + path), checks `/healthz`, and runs `npm run gmail:watch`.

### 22. After the first deploy
- [ ] Paste the printed Callback URL (`…/webhooks/whatsapp`) into Meta (step 15) and click **Verify and save**.
- [ ] `npm run gmail:watch` prints ✅ with an expiry about 7 days out for each connected account. The tick renews it.
- [ ] After `npm run auth -- <account>` (token reconnect), start a new revision so it reads the new secret:
  `gcloud run services update kiasu-assistant --region=asia-southeast1 --update-env-vars=SECRETS_REFRESHED_AT=$(date +%s)`
- [ ] Changing plain config (e.g. `CLASSROOM_ENABLED`) → edit `.env` → `npm run deploy`.
````

- [ ] (user) **Step 8: Deploy for real (manual)**

Run: `npm run deploy`
Expected, in order: `==> Checking that secrets have a value`, the Cloud Build log, then `Service URL …` (`status.url`), then the subscription and scheduler created, then `{"ok":true}`, then `✅ personal: watch expires …` (and school if connected), then the `Deployed: https://kiasu-assistant-<number>.asia-southeast1.run.app` block.
Then check:
```bash
gcloud pubsub subscriptions describe gmail-push-sub --format='value(pushConfig.oidcToken.audience)'
gcloud scheduler jobs describe tick --location=asia-southeast1 --format='value(httpTarget.oidcToken.audience)'
gcloud run services describe kiasu-assistant --region=asia-southeast1 --format=json | grep -A1 '"PUBLIC_BASE_URL"'
```
Expected: `<URL>/webhooks/gmail`, `<URL>/jobs/tick`, and `"value": "<URL>"`, all with the same `<URL>` and no trailing slash.

- [x] **Step 9: Full suite and commit**

```bash
npm test && npm run typecheck
git add scripts/lib/deploy-env.ts scripts/render-run-env.ts scripts/deploy.sh scripts/lib/watch.ts scripts/gmail-watch.ts \
  test/scripts/deploy-env.test.ts test/scripts/deploy.test.ts test/scripts/watch.test.ts package.json docs/setup.md
git commit -m "feat(infra): deploy.sh (Cloud Run + Pub/Sub push + Scheduler, OIDC) and gmail:watch"
```

---

### Task 7: End-to-end verification: `scripts/smoke.ts` and `docs/e2e-checklist.md`

**Files:**
- Create: `scripts/lib/smoke.ts`, `scripts/smoke.ts`, `docs/e2e-checklist.md`
- Modify: `package.json` (script `smoke`)
- Test: `test/scripts/smoke.test.ts`

**Interfaces:**
- Consumes: `createWhatsAppClient(config)` (plan 03); `FirestoreStore`, `createFirestore`, `toUtcIso`, `formatSgt` (plan 00); `fillFromSecretManager`, `projectFromEnv`, `ALL_SECRET_KEYS` (Task 1); `/jobs/tick?now=` with `DEV_SKIP_OIDC=true` (plan 04).
- Produces: `scripts/lib/smoke.ts`: `type SmokeCommand = "health" | "whatsapp" | "tick" | "close-window" | "all"`, `parseSmokeArgs(argv, env): { command; url: string; now: string | null }`, `isLocalUrl(url): boolean`, `tickUrl(base, now: string | null): string`, `daysBefore(now: Date, days: number): string`. Also npm script `smoke`.

- [x] **Step 1: Write the failing test**

`test/scripts/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseSmokeArgs, isLocalUrl, tickUrl, daysBefore } from "../../scripts/lib/smoke.js";

describe("smoke helpers", () => {
  it("parses command, url and now", () => {
    expect(parseSmokeArgs(["health"], {})).toEqual({ command: "health", url: "http://localhost:8080", now: null });
    expect(parseSmokeArgs(["tick", "--now=2026-10-14T06:31:00+08:00", "--url=http://127.0.0.1:9000/"], {}))
      .toEqual({ command: "tick", url: "http://127.0.0.1:9000", now: "2026-10-14T06:31:00+08:00" });
    expect(parseSmokeArgs(["all"], { SMOKE_URL: "https://x.run.app/" }).url).toBe("https://x.run.app");
    expect(() => parseSmokeArgs(["explode"], {})).toThrow(/Usage/);
  });
  it("only allows ?now against a local server", () => {
    expect(isLocalUrl("http://localhost:8080")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLocalUrl("https://kiasu-assistant-1.asia-southeast1.run.app")).toBe(false);
    expect(tickUrl("http://localhost:8080", "2026-10-14T06:31:00+08:00")).toBe(
      "http://localhost:8080/jobs/tick?now=2026-10-13T22%3A31%3A00.000Z");
    expect(tickUrl("http://localhost:8080", null)).toBe("http://localhost:8080/jobs/tick");
    expect(() => tickUrl("https://kiasu-assistant-1.asia-southeast1.run.app", "2026-10-14T06:31:00+08:00")).toThrow(/local/);
  });
  it("daysBefore gives a UTC ISO string", () => {
    expect(daysBefore(new Date("2026-10-14T00:00:00Z"), 2)).toBe("2026-10-12T00:00:00.000Z");
  });
});
```

- [x] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/scripts/smoke.test.ts`
Expected: FAIL, module not found.

- [x] **Step 3: Implement `scripts/lib/smoke.ts`**

```ts
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
```

- [x] **Step 4: Implement `scripts/smoke.ts`**

```ts
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
```

- [x] **Step 5: Add the npm script and run the tests**

```bash
npm pkg set "scripts.smoke=tsx --env-file=.env scripts/smoke.ts"
npx vitest run test/scripts/smoke.test.ts && npm run typecheck
```
Expected: 3 passed, and typecheck exits 0.

- [x] **Step 6: Write `docs/e2e-checklist.md`**

````markdown
# End-to-end checklist

Run top to bottom after every significant change. Tick the boxes in a copy, not in git.
Never paste email contents or phone numbers into this file.

## A. Local (Firestore emulator + cloudflared + `DEV_SKIP_OIDC=true`)
Setup: docs/setup.md Part 3 (three terminals). Meta's Callback URL points at the tunnel.

- [ ] `npm run smoke -- health` → `✅ healthz 200 {"ok":true}`
- [ ] From your phone, send "hi" to the bot → a reply arrives within ~20s (agent via the inline task queue).
- [ ] `npm run smoke -- whatsapp` → the smoke-test text arrives.
- [ ] Morning brief: `npm run smoke -- tick --now=2026-10-14T06:31:00+08:00` → "*Good morning! …*" arrives with numbered items.
- [ ] Reply `done 1` → confirmation. Run the same tick with the next day's date → item 1 is gone.
- [ ] Reply `remind me in 2 minutes to stretch`, then run `npm run smoke -- tick` after 2 minutes → reminder arrives.
- [ ] Urgent email + quiet hours: from another account, email yourself *"Please submit the consent form by 9am tomorrow"*.
      `npm run smoke -- tick --now=<today>T23:00:00+08:00` → **no** alert (held).
      `npm run smoke -- tick --now=<tomorrow>T06:31:00+08:00` → the brief includes it.
- [ ] Template path: `npm run smoke -- close-window`, then `npm run smoke -- tick --now=<date>T21:01:00+08:00` →
      a `brief_ready` template arrives (not free text). Tap **Show me** → the full evening check-in arrives (outbox flush),
      with no extra agent reply.
- [ ] Non-text: send a photo → "I can only read text for now 🙂".
- [ ] A message from another number (ask a friend) → no reply, and a "dropped" log line.

## B. Production (Cloud Run)
- [ ] `npm run deploy` finished with `Deployed: <URL>`, and `npm run smoke -- health --url=<URL>` → 200.
- [ ] The three audiences match (docs/setup.md step 21 / plan 06 Task 6 Step 8).
- [ ] Meta webhook **Verify and save** succeeds with `<URL>/webhooks/whatsapp`. Send "status" → reply with sync health.
- [ ] Urgent email alert: email your school (or personal) inbox *"URGENT: reply needed by tomorrow 9am"* outside quiet hours
      → WhatsApp alert within ~1 minute. If it takes ~5 minutes, push isn't working (only the tick caught it):
      `gcloud run services logs read kiasu-assistant --region=asia-southeast1 --limit=50`, look for `/webhooks/gmail` 401s,
      and re-check the audiences and `npm run gmail:watch`.
- [ ] `gcloud scheduler jobs run tick --location=asia-southeast1` → logs show `POST /jobs/tick` 200 (not 401).
- [ ] Next morning: the brief arrives by 06:30 SGT. The evening check-in arrives by 21:00.
- [ ] Google Auth Platform → Audience still shows **In production**.
- [ ] After 3 days: `gcloud scheduler jobs describe tick --location=asia-southeast1` shows recent successful runs. The billing
      report shows about $0 for GCP (spec §14).
````

- [ ] (user) **Step 7: Run the checklist (manual)**

Run section A locally, then section B against production.
Expected: every box ticks. For any failure, use superpowers:systematic-debugging. Fix it in the owning plan's module, with a regression test there.

- [x] **Step 8: Full suite and commit** (`lint:sh` skipped: shellcheck not installed)

```bash
npm test && npm run typecheck && npm run lint:sh
git add scripts/lib/smoke.ts scripts/smoke.ts test/scripts/smoke.test.ts docs/e2e-checklist.md package.json
git commit -m "feat(infra): smoke script and end-to-end checklist"
```

---

## Self-review

**Spec coverage**
- §4 routes and auth: all six routes are registered and checked (Task 5 test). Unauthenticated Cloud Run with in-app auth: `--allow-unauthenticated` (Task 6) plus 401 checks (Task 5). Pub/Sub push, scheduler `*/5 * * * *` Asia/Singapore, and Cloud Tasks are all OIDC as `invoker@` (Tasks 2 and 6).
- §7a scopes: `GOOGLE_SCOPES` (plan 00) are requested by `auth-google.ts`, and the granted scopes are printed (Task 1). `CLASSROOM_ENABLED=false` advice (Task 1). It's passed to Cloud Run (Task 6).
- §12 secrets: the 8 secrets are created (Task 2), set via stdin (Tasks 1 and 2), and mounted with `--set-secrets` (Task 6). Plain config goes through the env YAML (Task 6). Desktop OAuth client, External + In production, loopback, `access_type=offline`, `prompt=consent` (Task 1). The `setup-gcp.sh` scope: the spec lists the subscription and scheduler job there, but they need the service URL, so `deploy.sh` creates them idempotently instead (Task 6). Behaviour is the same, ordering is safer.
- §13 risks: 1 (school OAuth) is Task 1 Steps 11–12 and the fallbacks (docs step 7, `adviceFor`). 2 (test number, recipient allowlist) and 3 (template category) are docs steps 11 and 16. 4 (Pub/Sub permissions) is the Task 2 grant plus the Task 6 `gmail:watch` hints.
- §14 cost: one scheduler job, min-instances 0, max-instances 1 (also required by plan 01's in-process sync lock), 512Mi.
- §11 local e2e: emulator, cloudflared, manual tick with fake time (Task 3 docs, Task 7).

**Placeholder scan:** no TBD/TODO. `<random-suffix>`, `<ACCOUNT_ID>`, `<WABA_ID>` and `<URL>` in the docs are values the human reads off their own console, not plan gaps.

**Type consistency:** `ALL_SECRET_KEYS` (Task 1) matches `REQUIRED_SECRETS`+`OPTIONAL_SECRETS` (Task 2), and a test enforces it. `runWithFakeCli` (Task 2) is reused unchanged in Task 6. `buildDeps`/`buildApp`/`BuildOptions` (Task 5) are used by `gmail-watch.ts` (Task 6). `refreshTokenKey`/`parseAccountArg` are shared by auth and check-access. The service name is `kiasu-assistant` in `common.sh`, the tests, deploy and docs. Resource names `gmail-push`, `gmail-push-sub`, `inbound`, `tick`, `invoker@` and `runtime@` are identical in `common.sh`, `deploy-env.ts` and the tests.

**Review Focus:** each of the 5 lines has a named test in its owning task (Tasks 1, 2, 5, 6).

**Verified against the installed `gcloud` 584 `--help` and the docs:** `run deploy --source/--env-vars-file/--set-secrets/--allow-unauthenticated`, `run services update --update-env-vars`, `pubsub subscriptions create|update --push-endpoint/--push-auth-service-account/--push-auth-token-audience/--ack-deadline`, `scheduler jobs create|update http --oidc-service-account-email/--oidc-token-audience/--time-zone/--attempt-deadline`, `tasks queues create|update` retry flags, `firestore databases create --database --location --type=firestore-native`, `secrets create --replication-policy`, `secrets versions add --data-file=-`, `meta list-files-for-upload`, `scheduler jobs run`, the `.gcloudignore` `#!include:.gitignore` syntax, Cloud Run's deterministic URL format, `roles/run.builder` for the compute SA on source deploys, the Pub/Sub service agent token-creator requirement, and Meta's system-user token permissions and 5-recipient test limit. The bash scripts and their fake-gcloud tests were prototyped and pass on macOS bash 3.2.
