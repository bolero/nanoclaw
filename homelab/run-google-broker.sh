#!/usr/bin/env bash
# Launcher for scripts/google-broker.ts (grants live in ~/.config/nanoclaw/google/, mode 600).
set -euo pipefail
cd "$(dirname "$0")/.."
# On-device PDF/image text helper (PDFKit + Vision), built from homelab-infra mac-mini-m4/doctext.
export DOCTEXT_BIN="${DOCTEXT_BIN:-$HOME/.local/bin/doctext}"
exec pnpm exec tsx scripts/google-broker.ts
