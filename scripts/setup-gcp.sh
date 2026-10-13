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
