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
