#!/usr/bin/env bash
# One run of scripts/mail-review-local.ts: review new mail with a LOCAL model (trial). No cloud model.
set -euo pipefail
cd "$(dirname "$0")/.."
exec pnpm exec tsx scripts/mail-review-local.ts "$@"
