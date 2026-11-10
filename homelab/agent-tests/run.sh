#!/usr/bin/env bash
# Family-agent scenario harness. Start the mock first: pnpm exec tsx homelab/agent-tests/mock-family.ts
# Needs a test agent group (same instructions as family + TEST MODE footer) whose MCP servers point at
# http://host.docker.internal:8799/{google,reminders,notes}/mcp. Scenarios: see scenarios.py.
# run.sh <scenario> [--keep]  (keep = don't reload mock state, for follow-ups); for follow-ups pass prompt via PROMPT env
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
cd "$D/../.."
T=${FAMILY_TEST_GROUP:?set FAMILY_TEST_GROUP to the family-test agent group id}; name=$1
if [ "${2:-}" != "--keep" ]; then curl -s -X POST 127.0.0.1:8799/admin/scenario -d "$(python3 $D/scenarios.py $name scenario)" >/dev/null; fi
P=${PROMPT:-$(python3 $D/scenarios.py $name prompt)}
sid=$(ncl tasks create --group $T --name "t-$name" --process-after "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --prompt "$P" | python3 -c 'import json,sys; print(json.load(sys.stdin)["series_id"])')
f=groups/family-test/tasks/$sid.md
n=0; until [ -s "$f" ] || [ $n -ge 60 ]; do n=$((n+1)); sleep 5; done
echo "===== $name ($sid)"; cat "$f" 2>/dev/null | tail -c 2500; echo
curl -s 127.0.0.1:8799/admin/calls | python3 -c '
import json,sys; d=json.load(sys.stdin)
for c in d["calls"]: print("CALL", c["server"], c["name"], json.dumps(c["args"])[:260], "=>", c["result"][:120].replace(chr(10)," "))'
