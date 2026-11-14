#!/usr/bin/env bash
# One run of scripts/mail-autoarchive.ts (home.yaml `mail_archive` rules: exact sender + attachment -> Paperless).
# No model is involved. Run it hourly from a timer; pass --dry-run to preview.
set -euo pipefail
cd "$(dirname "$0")/.."
exec pnpm exec tsx scripts/mail-autoarchive.ts "$@"
