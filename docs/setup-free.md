# kiasu-assistant setup: free hosting, no card (Telegram + Render + Firebase Spark + cron-job.org)

This is the setup to use when Google Cloud billing (card hold) or Meta WhatsApp (verified business) isn't an option.
For the original Cloud Run + WhatsApp setup (with billing), see `docs/setup.md`.

| Piece | Free service | Replaces |
|---|---|---|
| Chat | Telegram bot (`MESSENGER=telegram`) | Meta WhatsApp Cloud API |
| Server | Render free web service (`render.yaml`) | Cloud Run |
| Database | Firestore on Firebase's free **Spark** plan, service-account key in `FIRESTORE_CREDENTIALS_JSON` | Firestore with Application Default Credentials |
| Clock | cron-job.org calls `POST /jobs/tick` every 5 minutes with `Authorization: Bearer <JOB_SECRET>` | Cloud Scheduler + OIDC |
| New mail | Polled on every tick (no `GMAIL_PUBSUB_TOPIC`) | Gmail push via Pub/Sub |
| Message queue | In-process (no `TASKS_QUEUE`) | Cloud Tasks |

You've already done Google OAuth for both accounts (`GOOGLE_REFRESH_TOKEN_PERSONAL` / `_SCHOOL` are in `.env`,
and `npm run check:access` passes) and have an Anthropic API key. Commands run from `~/Kiasu-assistant`.
Never commit `.env` or the Firebase key file, and never paste a secret onto a command line.

**Good to know about Render free:**
- Free web services get **750 instance hours per month** per workspace. One service running 24/7 uses about 744, so it fits,
  but don't run a second free service in the same workspace.
- A free service **sleeps after 15 min** with no incoming traffic, and the next request waits about a minute while it
  wakes up. The 5-minute cron-job.org tick keeps it awake, so Telegram messages get quick answers.
- New mail is noticed on the next tick, so expect up to about 5 minutes' delay (push used to take about 1 minute).

## 1. Telegram bot

1. In Telegram, open **@BotFather** and send `/newbot`. Pick a display name, then a username ending in `bot`.
   BotFather replies with a token like `123456789:AA…`. Put it in `.env`:
   ```
   MESSENGER=telegram
   TELEGRAM_BOT_TOKEN=<the token from BotFather>
   ```
2. Open your new bot in Telegram and send it **hi** (or tap **Start**).
3. Find your chat id:
   ```bash
   npm run telegram:chat-id
   ```
   It prints `chat id <number>  <your first name>: hi`. Put that number in `.env` as `TELEGRAM_CHAT_ID=<number>`.
   (If it says a webhook is set, it prints the `deleteWebhook` link to open first.) Until `TELEGRAM_CHAT_ID` is set,
   the server ignores every message and logs its chat id at warn level, so the Render logs show it too.
4. Generate the two shared secrets straight into `.env` (they're never shown on screen):
   ```bash
   printf 'TELEGRAM_WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
   printf 'JOB_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
   ```
   `openssl rand -hex 32` gives 64 hex characters: valid for Telegram's secret token (16–256 of `A-Z a-z 0-9 _ -`)
   and long enough for `JOB_SECRET` (32+). Open `.env` in an editor when you need to copy them into Render (step 3).

## 2. Firebase (Firestore on the free Spark plan)

1. Go to **console.firebase.google.com** → **Create a project** → choose to add Firebase to your **existing Google
   Cloud project** (the one with your OAuth client; its project ID is your `GCP_PROJECT`).
2. Stay on the **Spark** (no-cost) plan. Don't upgrade to Blaze; that needs a card. Analytics isn't needed.
3. **Build → Firestore Database → Create database**: **Native** mode, start in **production mode**, location
   **asia-southeast1 (Singapore)**. Keep the database ID `(default)`. The location can't be changed later.
   Production-mode rules block browser clients, which is right: only the server (with the admin key) uses it.
4. **Project settings** (gear icon) → **Service accounts** → **Firebase Admin SDK** → **Generate new private key**.
   A JSON file downloads. **Never commit it**, and delete it from Downloads once it's in Render.
   You'll paste its content as `FIRESTORE_CREDENTIALS_JSON` in Render. To copy it as one line without printing it:
   ```bash
   node -e 'process.stdout.write(JSON.stringify(require(process.argv[1])))' ~/Downloads/<the-key-file>.json | pbcopy
   ```
Spark's daily quota (50k reads, 20k writes, 1 GiB) is plenty for one user and a tick every 5 minutes.
No composite indexes are needed.

## 3. Render

1. Push this repo to GitHub as `sontungalt/kiasu` (private is fine) if it isn't there yet.
2. On render.com: **New → Blueprint** → connect GitHub → pick the repo `sontungalt/kiasu`. Render reads `render.yaml`
   and shows one free web service, `kiasu-assistant`, in Singapore.
3. Fill in the values it asks for (these `sync: false` values are only asked for this once; later changes go in the
   service's **Environment** tab):

   | Key | Value |
   |---|---|
   | `GCP_PROJECT` | your Google Cloud / Firebase project ID |
   | `PUBLIC_BASE_URL` | for now `https://kiasu-assistant.onrender.com` (fixed in step 5) |
   | `ANTHROPIC_API_KEY` | from `.env` |
   | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | from `.env` |
   | `GOOGLE_REFRESH_TOKEN_PERSONAL`, `GOOGLE_REFRESH_TOKEN_SCHOOL` | from `.env` |
   | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` | from `.env` |
   | `JOB_SECRET` | from `.env` |
   | `FIRESTORE_CREDENTIALS_JSON` | paste the one-line key JSON from step 2.4 |
   | `CLASSROOM_ENABLED` | `true` (or `false` if your school blocks Classroom) |

   `NODE_ENV=production`, `MESSENGER=telegram`, the model IDs and `GCP_REGION` come from `render.yaml`.
   Leave `GMAIL_PUBSUB_TOPIC`, `INVOKER_SERVICE_ACCOUNT` and `TASKS_QUEUE` unset: that's what turns on polling,
   bearer-secret job auth and the in-process queue.
4. **Deploy** (Apply). The build runs `npm ci --include=dev && npm run build`; the service starts with
   `node dist/main.js` and Render checks `/healthz`. If it fails at startup, the log line `startup failed` lists the
   missing or invalid variable names (never their values).
5. Note the service URL at the top of the page, `https://….onrender.com`. If it differs from what you entered, set
   `PUBLIC_BASE_URL` to it in **Environment** and redeploy (**Manual Deploy → Deploy latest commit**).

## 4. Point Telegram at the server

```bash
npm run telegram:webhook -- https://<your-service>.onrender.com
```
This calls `setWebhook` for `<url>/webhooks/telegram` with your `TELEGRAM_WEBHOOK_SECRET`, only `message` updates,
and drops anything that was pending, then prints `getWebhookInfo` (never the token). A "last error … 401" means the
secret in `.env` and in Render differ. Make them equal and run it again.

## 5. cron-job.org (the 5-minute tick)

1. Sign up for a free account at **cron-job.org** → **Create cronjob**.
2. **URL**: `https://<your-service>.onrender.com/jobs/tick`
3. **Schedule**: every 5 minutes. **Time zone**: `Asia/Singapore`.
4. **Advanced**: request method **POST**; add a header `Authorization` with value `Bearer <JOB_SECRET>`
   (the word `Bearer`, a space, then the secret from `.env`). The full header is `Authorization: Bearer <JOB_SECRET>`.
5. Save, then use **Test run**: it should answer 200 with a JSON report of the tick steps. A 401 means the header is
   wrong. An occasional timeout while Render wakes up, or while many new emails are triaged, is harmless: the server
   finishes the tick anyway, and the next tick catches up.

## 6. Smoke test

- [ ] `https://<your-service>.onrender.com/healthz` in a browser shows `{"ok":true}`.
- [ ] Send the bot **hi**. It answers within a few seconds (about a minute if it was asleep).
- [ ] Ask **what's due this week?** It lists items with numbers; try `done 1`.
- [ ] Wait for the next brief: the evening check-in at **21:00** or the morning brief at **06:30** (SGT).
- [ ] In the Render logs, ticks show `gmail sync done` for both accounts every 5 minutes.

## Later changes
- New refresh token (`npm run auth -- <account>`): paste it into Render's **Environment** tab; Render redeploys.
- Rotate `TELEGRAM_WEBHOOK_SECRET`: change it in `.env` and Render, then run `npm run telegram:webhook -- <url>` again.
- Rotate `JOB_SECRET`: change it in Render and in the cron-job.org header.
