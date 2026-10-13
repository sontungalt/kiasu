# Triage eval

This runs about 25 of your real emails through `triageEmail` with the real model and checks the results against your hand labels.

**Pass bar (spec §11):** zero missed urgent items, and every labelled deadline has the right due date. Category accuracy, importance accuracy and false alarms are reported, but they don't fail the run.

Fixtures (`evals/triage/fixtures/`) and labels (`evals/triage/labels.json`) are gitignored. Never commit them.

## 1. Export fixtures

You need a filled-in `.env` with the Google OAuth client and both refresh tokens.

    npm run export:fixtures -- school "in:inbox newer_than:30d -category:promotions -category:social" 15
    npm run export:fixtures -- personal "in:inbox newer_than:30d -category:promotions -category:social" 10

This writes `evals/triage/fixtures/<account>-<gmailId>.json` (a `ParsedEmail`) and adds an unlabelled entry for each email to `labels.json`. Gmail is only read.

Aim for a mix: teacher requests with deadlines, schedule changes (venue, time, cancellation), CCA notices, newsletters, receipts and security alerts. Include **at least 5 emails that should be urgent** and **at least 2 with relative dates** ("tomorrow", "next Friday"), ideally one received late at night (after 23:00 SGT). Use a narrower `q` (for example `from:school.edu.sg newer_than:60d`) to find specific emails.

## 2. Redact

The exporter already replaces email local parts (domains are kept, because they matter), phone numbers, NRIC numbers, long numbers and URL query strings. Then open each fixture and, by hand, replace the names of students and family, home addresses, and anything else private. Keep dates, times, sender domains and the wording of each request, because that's what's being tested. Don't change `date`, since relative dates resolve against it.

## 3. Label

Edit `labels.json` (see `labels.example.json`). For each email:
- `"labelled": true`
- `category` and `importance`, using the values from spec §7
- `expectUrgent`: true if it needs action within about 36h of arriving, a teacher or the school asks you to act or reply, or a schedule changed
- `deadlines`: `[{ "match": "<lowercase words from the expected item title>", "dueAt": "2026-10-17T23:59:00+08:00" }]`. A deadline with no time means 23:59 that day.

## 4. Run

    npm run eval:triage            # all labelled fixtures
    npm run eval:triage -- school  # only fixture ids containing "school"

Each email is triaged as if it were processed 5 minutes after it arrived. Add `"now": "<ISO>"` to a fixture to override that. The exit code is 0 for a pass, 1 for a fail, and 2 for a setup problem. A run is about 25 Haiku calls, which costs about a cent.

If an urgent item is missed, fix the prompt in `src/triage/prompt.ts` (not the label, unless the label was wrong) and rerun until it passes.
