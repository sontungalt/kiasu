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
