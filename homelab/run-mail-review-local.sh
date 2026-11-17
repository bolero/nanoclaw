#!/usr/bin/env bash
# One run of scripts/mail-review-local.ts: review new mail with a LOCAL model (trial). No cloud model.
# The lock keeps runs from overlapping (a slow run is never joined by the next timer tick), so the
# local model only ever serves one request at a time.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/mail-review
exec flock -n data/mail-review/.run.lock pnpm exec tsx scripts/mail-review-local.ts "$@"
