#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
root=${KNOWLEDGE_BITS_ROOT:-${script_dir:h:h}}
env_file=${KNOWLEDGE_BITS_ENV_FILE:-${root}/.env}
lock_dir="${TMPDIR:-/tmp}/knowledge-bits-worker-tick.lock"

if [[ ! -f "$env_file" ]]; then
  print -u2 "Knowledge Bits environment file not found: $env_file"
  exit 1
fi

# launchd can begin a new interval while a provider call is still in progress.
# This lock makes each tick single-flight.
if ! mkdir "$lock_dir" 2>/dev/null; then
  print "Knowledge Bits worker tick skipped: another tick is still running."
  exit 0
fi
trap 'rmdir "$lock_dir"' EXIT

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH}"
set -a
source "$env_file"
set +a

export ENGINE_API_BASE_URL="${KNOWLEDGE_BITS_LOCAL_API_URL:-http://127.0.0.1:3000}"
export WORKER_PROVIDER_MODE="${WORKER_PROVIDER_MODE:-production}"

if [[ -z "${ARTIFACT_STORAGE_MODE:-}" ]]; then
  export ARTIFACT_STORAGE_MODE="filesystem"
fi

if [[ "$ARTIFACT_STORAGE_MODE" == "filesystem" && -z "${ARTIFACT_STORAGE_FILESYSTEM_ROOT:-}" ]]; then
  export ARTIFACT_STORAGE_FILESYSTEM_ROOT="${root}/.local-artifacts"
fi

if [[ -z "${PRODUCT_RECIPE_ROOTS:-}" ]]; then
  export PRODUCT_RECIPE_ROOTS='{"nuglet.lesson.v1":"/Users/dearkane/Documents/dev/nuglet/apps/nuglet-lab/recipes/nuglet.lesson.v1"}'
fi

cd "$root"
/usr/local/bin/pnpm --filter @knowledge-bits/worker exec tsx src/index.ts
