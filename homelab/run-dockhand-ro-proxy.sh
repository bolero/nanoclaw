#!/usr/bin/env bash
# Launcher for scripts/dockhand-ro-proxy.ts; token comes from a private env file (mode 600).
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${DOCKHAND_PROXY_ENV:-$HOME/.config/nanoclaw/dockhand-proxy.env}"
set -a; . "$ENV_FILE"; set +a
exec pnpm exec tsx scripts/dockhand-ro-proxy.ts
