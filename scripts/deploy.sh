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
