# ---------------------------------------------------------------------------
# supervise-otp-ingest.ps1 - run the OTP walk in CHUNKS, with a reachability
# gate, a stop file and a wall-clock deadline.
#
# scripts/run-otp-ingest.ps1 launches ONE long ingest and hopes. This script is
# what you actually want for a multi-hour walk, and every one of its four
# behaviours is a scar from 2026-08-21, not a preference:
#
#  1. CHUNKS. scripts/ingest-otp.mjs has NO retry for a transport failure. A
#     ~10 minute Neon blip made it fail EVERY remaining champion in sequence,
#     print "done", and EXIT 0: a 144-champion queue gone in 12 minutes, and a
#     failed run indistinguishable from a clean one by exit code. Chunking caps
#     the blast radius of a blip at one chunk. The honest fix is retry inside
#     ingest-otp.mjs; until that exists, this is the only thing standing
#     between a blip and a silently half-empty corpus.
#
#  2. A REACHABILITY GATE before every chunk (scripts/db-ping.mjs, 6 attempts,
#     60s backoff). Never start a chunk into a database that is not there.
#
#  3. A STOP FILE, checked before every chunk. A process-tree kill issued that
#     day reported success against a worker that then ran for 12 MORE MINUTES,
#     still spending the Riot key - the tree walk found no descendants because
#     the worker was no longer parented to the PID being held. Stopping must
#     therefore be a file write whose effect is VISIBLE IN THE LOG, not a kill
#     whose success has to be taken on trust.
#
#  4. A DEADLINE (-DeadlineUtc). Riot's key budget is per-key, not per-process,
#     and lib/pro/pacer.ts only serialises WITHIN a process (CLAUDE.md gotcha
#     (d)) - so two Riot-calling ingests overlapping is how the key gets
#     suspended and the whole app goes dark. A walk long enough to cross the
#     next scheduled Riot ingest must stop itself before it. The check is
#     "would this chunk FINISH in time", not "has the deadline passed": a chunk
#     started a minute before the deadline runs a full chunk past it.
#
# It dot-sources scripts/_cbnew-db.ps1 and tests the $CbnewDbResolved sentinel,
# exactly as the five scheduled wrappers do, so the log records WHICH database
# this run resolved ("DATABASE_URL -> ep-..."). That line is the only thing
# that can answer "did that walk write to the rebuilt project?" after the fact;
# without it the 2026-08-20 outage went nine hours unnoticed. An `exit` inside
# a dot-sourced file does NOT abort the caller (measured), so the sentinel test
# below is the load-bearing half of the guard, not decoration.
#
# Run by hand:
#   powershell -NoProfile -File scripts\supervise-otp-ingest.ps1 -Chunk 6 -Chunks 13 -DeadlineUtc 2026-08-22T00:15:00Z
#
# Stop it gracefully (it finishes the chunk in flight, then exits):
#   New-Item -ItemType File C:\Claude\AI\coachbuild\.otp-ingest.stop
# ---------------------------------------------------------------------------
param(
  # Champions per chunk. Small enough that a blip is cheap, large enough that
  # process startup is not the dominant cost. ~3.73 min/champion measured.
  [int]$Chunk = 6,
  [int]$Chunks = 13,
  [string]$Root = "C:\Claude\AI\coachbuild",
  # Default is the repo-root stop file the previous lane established.
  [string]$StopFile = "",
  # ISO-8601 UTC, e.g. 2026-08-22T00:15:00Z. Empty = no deadline.
  [string]$DeadlineUtc = "",
  # Used ONLY to decide whether the next chunk fits before the deadline.
  # Rounded UP from the measured rate on purpose: over-estimating stops early,
  # under-estimating overruns into another ingest's Riot budget.
  [double]$MinutesPerChampion = 4.0,
  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"

$logDir = Join-Path $env:LOCALAPPDATA "CoachBuild"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = if ($LogPath -ne "") { $LogPath } else { Join-Path $logDir "otp-ingest.out.log" }

function Say($m) {
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Add-Content -Path $log -Value "[supervisor $stamp] $m" -Encoding utf8
}

# Resolve the database explicitly, or refuse. Never fall back to .env.local:
# scripts/_env.mjs fills only keys that are still undefined, so an unset
# DATABASE_URL here silently means the OLD, quota-exhausted, matchday-shared
# project - which is not an error to _env.mjs, it is a fallback.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Join-Path $Root "scripts" }
. (Join-Path $scriptDir "_cbnew-db.ps1") -Root $Root -LogPath $log
if (-not $CbnewDbResolved) { exit 78 }

Set-Location $Root
$stop = if ($StopFile -ne "") { $StopFile } else { Join-Path $Root ".otp-ingest.stop" }
$tsx  = Join-Path $Root "node_modules\tsx\dist\cli.mjs"
if (-not (Test-Path $tsx)) { throw "missing $tsx - run npm install" }

$deadline = $null
if ($DeadlineUtc -ne "") {
  $styles = [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor `
            [System.Globalization.DateTimeStyles]::AssumeUniversal
  $deadline = [datetime]::ParseExact(
    $DeadlineUtc, "yyyy-MM-ddTHH:mm:ssZ",
    [System.Globalization.CultureInfo]::InvariantCulture, $styles)
}

$deadlineLabel = if ($deadline) { $deadline.ToString("yyyy-MM-ddTHH:mm:ssZ") } else { "none" }
Say "start pid=$PID chunk=$Chunk chunks=$Chunks stopfile=$stop deadline=$deadlineLabel"

$done = 0
$stopReason = "all chunks completed"

for ($i = 1; $i -le $Chunks; $i++) {

  # (3) Stop file first - it must win over everything, including a pending ping.
  if (Test-Path $stop) {
    $stopReason = "STOP FILE present - exiting before chunk $i"
    Say $stopReason
    break
  }

  # (4) Deadline: would this chunk FINISH in time, not has the deadline passed.
  if ($deadline) {
    $projected = (Get-Date).ToUniversalTime().AddMinutes($Chunk * $MinutesPerChampion)
    if ($projected -gt $deadline) {
      $p = $projected.ToString("yyyy-MM-ddTHH:mm:ssZ")
      $stopReason = "DEADLINE: chunk $i would finish $p, past $deadlineLabel - stopping"
      Say $stopReason
      break
    }
  }

  # (2) Reachability gate.
  $ok = $false
  for ($a = 1; $a -le 6; $a++) {
    $ping = & node $tsx (Join-Path $Root "scripts\db-ping.mjs") 2>&1
    if ($LASTEXITCODE -eq 0) {
      $ok = $true
      if ($a -gt 1) { Say "ping recovered on attempt $a" }
      break
    }
    Say "ping failed (attempt $a of 6): $ping - backing off 60s"
    Start-Sleep -Seconds 60
  }
  if (-not $ok) {
    $stopReason = "database unreachable after 6 attempts - exiting before chunk $i"
    Say $stopReason
    break
  }

  Say "chunk $i/$Chunks starting ($Chunk champions)"
  & node $tsx "scripts\ingest-otp.mjs" --champions $Chunk *>&1 |
    Out-File -Append -Encoding utf8 $log
  Say "chunk $i/$Chunks exit code=$LASTEXITCODE"
  # NOTE: exit 0 does NOT mean the chunk did any work - see (1). The per-champion
  # [otp] lines in the log are the evidence, and the ping gate above is what
  # makes a run of them trustworthy.
  $done = $i
}

Say "supervisor done - $done of $Chunks chunk(s) run ($stopReason)"
