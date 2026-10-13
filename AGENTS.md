# Instructions for coding agents (Codex, Cursor, Claude Code, …)

This repo is **kiasu-assistant**: a single-user assistant that reads my personal and school Gmail,
Google Calendar and Google Classroom, keeps a task list, and talks to me on WhatsApp.
Node 24 + TypeScript (ESM), Fastify, Zod, vitest, Firestore, Cloud Run.

## Status (2026-10-13)
All plans (00–06) are implemented and merged: 453 tests pass, and typecheck and build are clean.
What's left are the **user-only setup steps**, marked `- [ ] (user)` in plan 06 and described in
`docs/setup.md`: create the GCP project, run `npm run auth` and `npm run check:access`, set up Meta WhatsApp
and its templates, `npm run deploy`, then work through `docs/e2e-checklist.md`. Unverified so far:
`FirestoreStore` against a real emulator/Firestore (`npm run test:firestore`), and the triage eval on real emails
(`npm run eval:triage`).

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
