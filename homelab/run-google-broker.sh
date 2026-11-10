#!/usr/bin/env bash
# Launcher for scripts/google-broker.ts (grants live in ~/.config/nanoclaw/google/, mode 600).
set -euo pipefail
cd "$(dirname "$0")/.."
exec pnpm exec tsx scripts/google-broker.ts
