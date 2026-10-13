#!/usr/bin/env bash
# Stores a new version of a Secret Manager secret. The value never appears in argv or shell history.
#
# Usage:  scripts/set-secret.sh NAME                 (prompts; input is hidden)
#         some-command | scripts/set-secret.sh NAME  (reads the first line of stdin)
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/common.sh
source scripts/lib/common.sh

name="${1:-}"
if [[ -z "$name" ]]; then die "Usage: scripts/set-secret.sh NAME"; fi
known=false
for s in "${REQUIRED_SECRETS[@]}" "${OPTIONAL_SECRETS[@]}"; do
  if [[ "$s" == "$name" ]]; then known=true; fi
done
if [[ "$known" != "true" ]]; then
  die "Unknown secret '$name'. Known: ${REQUIRED_SECRETS[*]} ${OPTIONAL_SECRETS[*]}"
fi

load_project_env

value=""
if [[ -t 0 ]]; then
  printf 'Value for %s (input hidden): ' "$name" >&2
  IFS= read -rs value || true
  printf '\n' >&2
else
  IFS= read -r value || true
fi
if [[ -z "$value" ]]; then die "Empty value; nothing stored"; fi

# printf is a shell builtin, so the value never shows up in the process list.
printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --format=none
log "Stored a new version of $name in $GCP_PROJECT"
