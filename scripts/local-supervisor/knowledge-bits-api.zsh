#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
root=${KNOWLEDGE_BITS_ROOT:-${script_dir:h:h}}
env_file=${KNOWLEDGE_BITS_ENV_FILE:-${root}/.env}

if [[ ! -f "$env_file" ]]; then
  print -u2 "Knowledge Bits environment file not found: $env_file"
  exit 1
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH}"
set -a
source "$env_file"
set +a

# The migration owner credential must never be present in the API runtime.
unset ENGINE_MIGRATION_DATABASE_URL
export ENGINE_API_BASE_URL="${KNOWLEDGE_BITS_LOCAL_API_URL:-http://127.0.0.1:3000}"

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
exec /usr/local/bin/pnpm --filter @knowledge-bits/api exec tsx src/main.ts
