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
