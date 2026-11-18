#!/usr/bin/env bash
# Builds the Draft UI (the Next static export the desktop app embeds) from this checkout, from nothing:
# no .env file, no secrets, no League client, no network at run time. There is no server to start:
# the app serves desktop/ui/out/ under https://coachbuild.local through a WebView2 virtual host with no
# server behind it, and the drive script serves the same folder under the same origin.
# Usage: bash launch.sh        Optional: VERIFY_WRAP='env -u NODE_ENV bash /path/heavy-job.sh --label coachbuild-verify --'
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
S="$ROOT/.scratch/verify-coachbuild"
STATE="$S/state.env"
WRAP=${VERIFY_WRAP:-}
mkdir -p "$S/logs" "$S/browser"
cd "$ROOT"

if [[ -f "$STATE" ]]; then echo "launch: $STATE exists, an earlier run is not cleaned up. Run cleanup.sh first." >&2; exit 1; fi
for f in .env .env.*; do
  [[ -e "$f" ]] || continue
  [[ "$f" == .env.example || "$f" == .env*.example ]] && continue
  echo "launch: refusing, $f is in this checkout and Next would load it. Verify from a clean worktree." >&2; exit 1
done

CLEAN_ENV=(env -i PATH="$PATH" HOME="$HOME" NEXT_TELEMETRY_DISABLED=1)

# Runs a step, and when VERIFY_WRAP is a heavy-job gate records how long it waited for a slot.
QUEUE=0
step() { # step <log> <command...>
  local log=$1; shift; local t0=$SECONDS acquired=""
  $WRAP "$@" > "$log" 2>&1 &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [[ -z "$acquired" ]] && { [[ -z "$WRAP" ]] || grep -q 'heavy-job: nice' "$log"; }; then acquired=$SECONDS; QUEUE=$(( QUEUE + acquired - t0 )); fi
    sleep 0.5
  done
  wait "$pid"
}
[[ -d node_modules ]] || { echo "launch: npm ci"; step "$S/logs/npm-ci.log" "${CLEAN_ENV[@]}" npm ci --no-audit --no-fund; }
rm -rf "$ROOT/desktop/ui/out"   # a stale export must not pass for this checkout's build
echo "launch: building (log $S/logs/build.log)"
step "$S/logs/build.log" "${CLEAN_ENV[@]}" npm run build
echo "$QUEUE" > "$S/logs/queue-wait-seconds.txt"
echo "launch: waited ${QUEUE}s for a heavy-job slot"

OUT="$ROOT/desktop/ui/out"
[[ -f "$OUT/index.html" ]] || { echo "launch: build produced no $OUT/index.html, see $S/logs/build.log" >&2; exit 1; }
stamp() { echo "$(git rev-parse HEAD) $(git diff HEAD -- . ':!.scratch' | sha1sum | cut -c1-12)"; }
{ echo "OUT=$OUT"; echo "BUILD_STAMP='$(stamp)'"; echo "BUILT_AT=$(date +%s)"; } > "$STATE"
echo "launch: ready, export at $OUT ($(find "$OUT" -type f | wc -l) files). Nothing is listening: the drive serves it under https://coachbuild.local."
