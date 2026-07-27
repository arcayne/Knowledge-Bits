#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
root=${KNOWLEDGE_BITS_ROOT:-${script_dir:h:h}}
env_file=${KNOWLEDGE_BITS_ENV_FILE:-${root}/.env}
lock_dir="${TMPDIR:-/tmp}/knowledge-bits-worker-tick.lock"
lock_owner="${lock_dir}/pid"

if [[ ! -f "$env_file" ]]; then
  print -u2 "Knowledge Bits environment file not found: $env_file"
  exit 1
fi

# launchd can begin a new interval while a provider call is still in progress.
# This lock makes each tick single-flight and recovers after an unclean worker exit.
if ! mkdir "$lock_dir" 2>/dev/null; then
  lock_pid=""
  [[ -r "$lock_owner" ]] && read -r lock_pid < "$lock_owner"
  if [[ "$lock_pid" == <-> ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
    rm -f "$lock_owner"
    rmdir "$lock_dir" 2>/dev/null || true
  fi
  if ! mkdir "$lock_dir" 2>/dev/null; then
    print "Knowledge Bits worker tick skipped: another tick is still running."
    exit 0
  fi
fi
print -r -- "$$" > "$lock_owner"
cleanup_lock() {
  rm -f "$lock_owner"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup_lock EXIT INT TERM

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH}"
set -a
source "$env_file"
set +a

export ENGINE_API_BASE_URL="${KNOWLEDGE_BITS_LOCAL_API_URL:-http://127.0.0.1:3000}"
export WORKER_PROVIDER_MODE="${WORKER_PROVIDER_MODE:-production}"

api_ready="false"
for attempt in {1..30}; do
  if curl --silent --show-error --fail --max-time 2 \
    "${ENGINE_API_BASE_URL%/}/health" >/dev/null 2>&1; then
    api_ready="true"
    break
  fi
  sleep 1
done
if [[ "$api_ready" != "true" ]]; then
  print -u2 "Knowledge Bits worker tick could not reach the local API health endpoint."
  exit 1
fi

if [[ -z "${ARTIFACT_STORAGE_MODE:-}" ]]; then
  export ARTIFACT_STORAGE_MODE="filesystem"
fi

if [[ "$ARTIFACT_STORAGE_MODE" == "filesystem" && -z "${ARTIFACT_STORAGE_FILESYSTEM_ROOT:-}" ]]; then
  export ARTIFACT_STORAGE_FILESYSTEM_ROOT="${root}/.local-artifacts"
fi

if [[ -z "${PRODUCT_RECIPE_ROOTS:-}" ]]; then
  export PRODUCT_RECIPE_ROOTS="{\"nuglet.lesson.v1\":\"${root}/recipes/nuglet.lesson.v1\"}"
fi

if [[ -z "${MEDIA_GENERATION_COMMAND:-}" ]]; then
  export MEDIA_GENERATION_COMMAND="/opt/homebrew/bin/node"
  export MEDIA_GENERATION_ARGS="[\"${root}/apps/worker/scripts/nuglet-media-command.mjs\"]"
fi

cd "$root"
/usr/local/bin/pnpm --filter @knowledge-bits/worker exec tsx src/index.ts
