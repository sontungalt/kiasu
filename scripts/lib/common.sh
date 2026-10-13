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
