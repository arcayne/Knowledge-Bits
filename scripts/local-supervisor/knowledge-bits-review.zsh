#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
root=${KNOWLEDGE_BITS_ROOT:-${script_dir:h:h}}
env_file=${KNOWLEDGE_BITS_ENV_FILE:-${root}/.env}

if [[ ! -f "$env_file" ]]; then
  print -u2 "Knowledge Bits environment file not found: $env_file"
  exit 1
fi

export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH}"
set -a
source "$env_file"
set +a

review_port="${KNOWLEDGE_BITS_REVIEW_PORT:-4323}"
export ENGINE_API_URL="${KNOWLEDGE_BITS_LOCAL_API_URL:-http://127.0.0.1:3000}"
export REVIEW_PUBLIC_ORIGIN="${REVIEW_PUBLIC_ORIGIN:-http://127.0.0.1:${review_port}}"

if [[ -z "${REVIEW_LOCAL_OPERATOR_ID:-}" ]]; then
  print -u2 "REVIEW_LOCAL_OPERATOR_ID is required for the local review service."
  exit 1
fi

cd "$root"
exec /usr/local/bin/pnpm --filter @knowledge-bits/review exec astro dev \
  --host 0.0.0.0 \
  --port "$review_port"
