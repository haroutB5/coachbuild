#!/usr/bin/env bash
# Stops only a browser the drive recorded in state.env (by pid, never by name) and drops the state
# file. The export, logs and every evidence directory stay. Safe to run twice.
# Usage: bash cleanup.sh
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
STATE="$ROOT/.scratch/verify-coachbuild/state.env"
[[ -f "$STATE" ]] || { echo "cleanup: nothing to clean"; exit 0; }
# shellcheck disable=SC1090
source "$STATE"
if [[ -n "${BROWSER_PID:-}" ]] && kill -0 "$BROWSER_PID" 2>/dev/null; then
  kill "$BROWSER_PID" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$BROWSER_PID" 2>/dev/null || break; sleep 0.25; done
  kill -0 "$BROWSER_PID" 2>/dev/null && kill -9 "$BROWSER_PID" 2>/dev/null
  echo "cleanup: stopped browser pid $BROWSER_PID"
fi
rm -f "$STATE"
echo "cleanup: done, evidence kept in $ROOT/.scratch/verify-coachbuild/evidence"
exit 0
