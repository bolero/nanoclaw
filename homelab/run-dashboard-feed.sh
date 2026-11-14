#!/usr/bin/env bash
# One run of scripts/dashboard-feed.ts (the app's Today/Ops boards). Run it from a timer every few minutes.
# Reads home.yaml `dashboard`, Google grants (~/.config/nanoclaw/google/), Gatus, alerts.db and `ncl`.
set -euo pipefail
cd "$(dirname "$0")/.."
exec pnpm exec tsx scripts/dashboard-feed.ts "$@"
