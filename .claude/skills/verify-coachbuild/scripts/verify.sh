#!/usr/bin/env bash
# One command: launch, doctor, drive feature 1, keep evidence, always clean up.
# Usage: bash verify.sh            Exit 0 = PASS, 1 = the feature failed, 2 = launch or doctor failed.
# Optional: VERIFY_WRAP='env -u NODE_ENV bash /path/heavy-job.sh --label coachbuild-verify --' for the npm and build steps.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
S="$ROOT/.scratch/verify-coachbuild"
EV="$S/evidence/$(date -u +%Y%m%dT%H%M%SZ)"
START=$(date +%s)
mkdir -p "$EV" "$S/logs" "$S/browser"
cleanup() { bash "$HERE/cleanup.sh" | tee -a "$EV/run.log"; }
trap cleanup EXIT

{
  echo "verify-coachbuild $(git -C "$ROOT" rev-parse --short HEAD) $(date -u +%FT%TZ)"
  bash "$HERE/launch.sh" || { echo "RESULT launch failed"; exit 2; }
  bash "$HERE/doctor.sh" || { echo "RESULT doctor failed"; exit 2; }
} 2>&1 | tee "$EV/run.log"
rc=${PIPESTATUS[0]}
if [[ $rc -ne 0 ]]; then cp "$S"/logs/*.log "$EV/" 2>/dev/null; echo "RESULT FAIL (launch or doctor), evidence $EV"; exit 2; fi

node "$HERE/drive-draft-counters.mjs" --ui "$ROOT/desktop/ui/out" --root "$ROOT" --out "$EV" --profile "$S/browser" --state "$S/state.env" 2>&1 | tee -a "$EV/run.log"
drive=${PIPESTATUS[0]}
cp "$S"/logs/*.log "$EV/" 2>/dev/null
ln -sfn "$EV" "$S/evidence/latest"
secs=$(( $(date +%s) - START ))
queue=$(cat "$S/logs/queue-wait-seconds.txt" 2>/dev/null || echo 0)
timing="${secs}s total, ${queue}s waiting for a heavy-job slot, $(( secs - queue ))s of work"
if [[ $drive -eq 0 ]]; then echo "RESULT PASS in $timing, evidence $EV" | tee -a "$EV/run.log"; exit 0; fi
echo "RESULT FAIL in $timing, evidence $EV" | tee -a "$EV/run.log"; exit 1
