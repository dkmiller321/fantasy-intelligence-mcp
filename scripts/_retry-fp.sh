#!/bin/bash
cd "C:/Users/dkmil/vscode-workspace/FantasyAgent" || exit 1
for i in $(seq 1 40); do
  S=$(npx tsx scripts/_fp-probe.mts 2>/dev/null | tail -1)
  echo "$(date -u +%H:%M) quota probe: ${S:-error}"
  if [ "$S" = "200" ]; then
    echo "=== quota available, running full three-source sync ==="
    npx tsx scripts/sync-projections.ts --remote 2>&1 | grep -E "fantasypros|sleeper total|espn:|total rows|^done"
    exit 0
  fi
  sleep 900
done
echo "quota did not reset within 10 hours"
