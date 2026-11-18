#!/usr/bin/env bash
# Read-only. Answers: is the export launch.sh built worth driving? Exit 0 yes, 1 no with the reason.
# Usage: bash doctor.sh
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
S="$ROOT/.scratch/verify-coachbuild"
STATE="$S/state.env"
bad=0
no() { echo "doctor: NO  $*"; bad=1; }
ok() { echo "doctor: ok  $*"; }
[[ -f "$STATE" ]] || { echo "doctor: NO  no $STATE, run launch.sh first"; exit 1; }
# shellcheck disable=SC1090
source "$STATE"
cd "$ROOT"

now="$(git rev-parse HEAD) $(git diff HEAD -- . ':!.scratch' | sha1sum | cut -c1-12)"
[[ "$now" == "$BUILD_STAMP" ]] && ok "export matches this checkout ($now)" || no "checkout changed since the build ('$BUILD_STAMP' then, '$now' now), rerun cleanup.sh and launch.sh"
[[ -f "$OUT/index.html" ]] && ok "index.html present" || no "no $OUT/index.html"
# Every script and stylesheet the page references must exist in the export, or the page is blank.
missing=0
while read -r ref; do [[ -f "$OUT/${ref#/}" ]] || { no "index.html references $ref, not in the export"; missing=1; }; done \
  < <(grep -oE '(src|href)="/_next/[^"]+"' "$OUT/index.html" | sed -E 's/^(src|href)="//; s/"$//' | sort -u)
[[ $missing -eq 0 ]] && ok "every /_next asset the page references exists"
grep -q 'Companion test' "$OUT/index.html" && ok "the Draft page markup is in index.html" || no "index.html has no Draft page markup"
[[ -f "$ROOT/desktop/tests/CoachBuild.Core.Tests/Fixtures/champions.live.json" ]] && ok "champion roster fixture present" || no "roster fixture missing"
[[ -n "${CHROME_PATH:-}" && -x "$CHROME_PATH" ]] && br=$CHROME_PATH || br=$(ls /usr/bin/brave /usr/bin/chromium /usr/bin/google-chrome-stable /usr/bin/google-chrome 2>/dev/null | head -1)
[[ -n "$br" ]] && ok "browser $br" || no "no Chromium browser, set CHROME_PATH"
[[ -d "$ROOT/node_modules/puppeteer-core" ]] && ok "puppeteer-core installed" || no "puppeteer-core missing, run npm ci"
exit $bad
