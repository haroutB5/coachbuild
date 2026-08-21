# ---------------------------------------------------------------------------
# run-otp-ingest.ps1 - detached launcher for the OTP account+match ingest.
#
# Why this exists (same three reasons as run-rebuild-phase1.ps1):
#
#  1. It must write to the NEW Neon project WITHOUT touching .env.local.
#     scripts/_env.mjs only fills keys that are still undefined, so an
#     inherited DATABASE_URL wins over .env.local. The live DATABASE_URL is
#     untouched and the cutover flip stays a separate, deliberate act.
#  2. The credential is read from .env.cbnew at run time by EXACT key name and
#     never appears on a command line or in a log. .env.cbnew also holds a
#     DATABASE_URL key pointing at the OLD (exhausted) project, so the file is
#     never sourced wholesale.
#  3. The run is hours long and Riot-paced. It must outlive the shell that
#     started it and leave a readable record, so it logs to %LOCALAPPDATA%.
#
# WHY THIS RUN IS NEEDED AT ALL: lib/rebuild/plan.ts has no unit that writes
# coachbuild.otp_accounts (plan.ts:174 claims otp-featured does; it does not),
# so a completed phase-1 rebuild leaves otp_accounts empty and every one of the
# 5,109 ingested otp_matches unreachable behind /api/otp's INNER JOIN. The
# featured accounts that own those matches are NOT re-found by leaderboard
# discovery - measured on champion 99: 8 accounts discovered, 0 overlap - so
# discovery alone unlocks nothing and the match walk is unavoidable.
#
# Run by hand:  powershell -NoProfile -File scripts\run-otp-ingest.ps1 [-Champions 60]
# ---------------------------------------------------------------------------
param(
  [int]$Champions = 60,
  [string]$Root = "C:\Claude\AI\coachbuild"
)

$ErrorActionPreference = "Stop"

$envFile = Join-Path $Root ".env.cbnew"
if (-not (Test-Path $envFile)) { throw "missing $envFile" }

$line = Select-String -Path $envFile -Pattern '^CBNEW_DATABASE_URL=' | Select-Object -First 1
if (-not $line) { throw "CBNEW_DATABASE_URL not found in .env.cbnew" }
$url = $line.Line.Substring('CBNEW_DATABASE_URL='.Length).Trim().Trim('"').Trim("'")
if ($url -notmatch '-pooler\.') { throw "CBNEW_DATABASE_URL is not the pooled endpoint - refusing" }

$env:DATABASE_URL = $url

$logDir = Join-Path $env:LOCALAPPDATA "CoachBuild"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir "otp-ingest.out.log"

Set-Location $Root
"=== otp ingest start $(Get-Date -Format o) pid=$PID champions=$Champions ===" | Out-File -Append -Encoding utf8 $log

$tsx = Join-Path $Root "node_modules\tsx\dist\cli.mjs"
& node $tsx "scripts\ingest-otp.mjs" --champions $Champions *>&1 |
  Out-File -Append -Encoding utf8 $log

"=== otp ingest exit $(Get-Date -Format o) code=$LASTEXITCODE ===" | Out-File -Append -Encoding utf8 $log
exit $LASTEXITCODE
