#!/usr/bin/env bash
# Cloud-agnostic rule (CLAUDE.md): no AWS SDK import outside src/adapters/aws.
set -euo pipefail

cd "$(dirname "$0")/.."

matches=$(grep -rEn "require\(['\"](aws-sdk|@aws-sdk/)|from ['\"](aws-sdk|@aws-sdk/)" \
  --include='*.js' \
  src test tools 2>/dev/null | grep -v '^src/adapters/aws/' || true)

if [ -n "$matches" ]; then
  echo "Cloud-agnostic rule violated: AWS SDK imported outside src/adapters/aws:"
  echo "$matches"
  exit 1
fi

echo "OK: no AWS SDK imports outside src/adapters/aws."
