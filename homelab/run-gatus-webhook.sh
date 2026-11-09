#!/usr/bin/env bash
# Launcher for scripts/gatus-webhook.ts. Loads settings from a private env file
# (default ~/.config/nanoclaw/gatus-webhook.env, mode 600) so no secret lives in the repo.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${GATUS_WEBHOOK_ENV:-$HOME/.config/nanoclaw/gatus-webhook.env}"
set -a; . "$ENV_FILE"; set +a
exec node node_modules/.bin/tsx scripts/gatus-webhook.ts
