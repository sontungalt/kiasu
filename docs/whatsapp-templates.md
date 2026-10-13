# WhatsApp message templates

The bot can only send free-form text within 24 hours of my last message (Meta's customer-service window). Outside that window, `src/whatsapp/outbox.ts` stores the full message as pending and sends one of the two templates below. Tapping the quick-reply button (or sending anything) opens the window, and the pending messages are flushed.

The code sends language code **`en`** and positional body parameters (`{{1}}`, `{{2}}`, ...). Quick-reply buttons take no parameters, so the send request has a `body` component only. The template **names and language must match exactly**, or sends fail with error `132001`.

## Submit these in WhatsApp Manager

WhatsApp Manager → Message templates → Create template. For each one: **Category: Utility**, **Language: English (`en`)** (not English (US)), **Name** exactly as below.

### `brief_ready`

| Field | Value |
|---|---|
| Name | `brief_ready` |
| Category | Utility |
| Language | English (`en`) |
| Header | none |
| Body | `📚 Your {{1}} brief is ready: {{2}} due today, {{3}} urgent.` |
| Body samples | `{{1}}` = `morning`, `{{2}}` = `3`, `{{3}}` = `1` |
| Footer | none |
| Buttons | Quick reply: `Show me` |

Parameters the code sends: `{{1}}` is `morning` or `evening`, `{{2}}` is the count of items due today, and `{{3}}` is the count of urgent items (counts as strings, e.g. `"0"`).

### `heads_up`

The spec's body (`⚠️ Heads up: {{1}}`) **ends with a variable, and Meta rejects that** ("Leading or trailing parameters not allowed", error 2388299; since Oct 2025 the template can't even be created). So submit it with fixed text after the variable. There's still exactly one parameter, so no code changes.

| Field | Value |
|---|---|
| Name | `heads_up` |
| Category | Utility |
| Language | English (`en`) |
| Header | none |
| Body | `⚠️ Heads up: {{1}}` + blank line + `Tap Details to see the full message.` |
| Body samples | `{{1}}` = `Chem test moved from Thu to Fri 8am` |
| Footer | none |
| Buttons | Quick reply: `Details` |

Parameters the code sends: `{{1}}` is a one-line summary (for example the alert title, the reminder text, or "Reconnect your school account"). The client collapses newlines, tabs and space runs (they cause error `132018`), turns an empty value into `-`, and cuts it to 300 characters.

### The same thing through the Graph API (optional)

`POST https://graph.facebook.com/v23.0/<WABA_ID>/message_templates` with the bearer token `WA_ACCESS_TOKEN`:

```json
{
  "name": "brief_ready",
  "language": "en",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "📚 Your {{1}} brief is ready: {{2}} due today, {{3}} urgent.",
      "example": { "body_text": [["morning", "3", "1"]] }
    },
    { "type": "BUTTONS", "buttons": [{ "type": "QUICK_REPLY", "text": "Show me" }] }
  ]
}
```

```json
{
  "name": "heads_up",
  "language": "en",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "⚠️ Heads up: {{1}}\n\nTap Details to see the full message.",
      "example": { "body_text": [["Chem test moved from Thu to Fri 8am"]] }
    },
    { "type": "BUTTONS", "buttons": [{ "type": "QUICK_REPLY", "text": "Details" }] }
  ]
}
```

## Test number vs real number

Templates made on Meta's test number **don't carry over** to a real number (spec §13). Submit them again after registering the real number. The test number only delivers to allow-listed recipients, so add `MY_WHATSAPP_NUMBER` there.

## If Meta classifies them as Marketing (or rejects them)

Utility templates have to be about a specific account or transaction of mine, with nothing promotional. If a template is rejected, or approved as *Marketing*, **edit it** in WhatsApp Manager and resubmit under the **same name**. The code only knows `brief_ready` and `heads_up` (`TemplateName` in `src/types.ts`), so a new name would need a contract change. Keep the same number of parameters (3 and 1). Fallback wordings, from most to least preferred:

`brief_ready`
1. `Your {{1}} summary for your Kiasu account is ready: {{2}} items due today and {{3}} marked urgent. Tap Show me to view it.`
2. `Account update: your scheduled {{1}} task summary is ready. Items due today: {{2}}. Urgent items: {{3}}. Tap Show me to view it.`

`heads_up`
1. `Update on your Kiasu account: {{1}}. Tap Details to view it.`
2. `Account notice: {{1}}. Tap Details for the full notice.`

Rules that help with review: no emojis if a reviewer objects to them, no promotional words ("new", "offer", "check out"), name the account ("your Kiasu account"), and keep text before the first variable and after the last one. If Meta says the template has too many variables for its length, use fallback 1, which has more fixed text.

## Error codes the code handles

| Code | Meaning | Handling |
|---|---|---|
| 131047 | More than 24h since my last message (re-engagement) | The outbox treats the window as closed: the message stays pending and a template is sent |
| 131026 | Message undeliverable | The send fails: retried by `flush()`, marked `failed` after 5 attempts |
| 131056 / 130429 | Pair rate limit / throughput limit | Same as above (retried on the next tick) |
| 132000 / 132001 / 132018 | Template parameter count / missing template or language / bad parameter format | Logged. The pending message is flagged and the template is retried at most once per 10 minutes until I message the bot |
| 190 | Access token expired | Logged. Replace `WA_ACCESS_TOKEN` (use a permanent System User token) |

A 131047 can also arrive later as a `failed` status webhook instead of in the send response. The webhook logs failed statuses with their error codes, but it doesn't requeue the message (see the Review Focus in plan 03).

Sources: Meta's Cloud API docs (send messages, template components, utility templates, error codes, webhook payload references for `text`/`button`/`interactive`/`status`) at developers.facebook.com/documentation/business-messaging/whatsapp/.
