#!/usr/bin/env bash
# One run of scripts/upstream-check.ts: report new upstream NanoClaw commits to the app (no model, changes nothing live).
set -euo pipefail
cd "$(dirname "$0")/.."
exec pnpm exec tsx scripts/upstream-check.ts "$@"
