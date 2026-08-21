# ---------------------------------------------------------------------------
# _cbnew-db.ps1 - resolve DATABASE_URL to the REBUILT Neon project, or refuse.
#
# DOT-SOURCE THIS FROM EVERY SCHEDULED INGEST WRAPPER, before it launches node,
# AND CHECK THE SENTINEL. Both lines are required:
#
#     . (Join-Path $PSScriptRoot '_cbnew-db.ps1') -Root $repo -LogPath $log
#     if (-not $CbnewDbResolved) { exit 78 }
#
# ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
# Every scripts/ingest-*.mjs calls loadEnvLocal() from scripts/_env.mjs, which
# reads .env.local and assigns ONLY where `process.env[key] === undefined`.
# None of the five scheduled wrappers set DATABASE_URL, so all five silently
# inherited .env.local's value - ep-shy-bread-abcvjv57, the OLD Neon project,
# which is ALSO the project matchday uses and the one whose 100 CU-hour Free
# quota was exhausted on 2026-08-20.
#
# So enabling those tasks would have done two bad things at once: written
# nothing into the rebuilt database (ep-sparkling-block-zayzlal1, which would
# have stayed empty), and re-burned a quota shared with another live app. The
# fault was invisible because the wrappers had no failure mode - a missing
# DATABASE_URL is not an error to _env.mjs, it is a fallback.
#
# ── THIS IS A REFUSAL, NOT A FALLBACK ───────────────────────────────────────
# If CBNEW_DATABASE_URL cannot be resolved, $CbnewDbResolved is left $false and
# DATABASE_URL is left untouched, so the caller's `exit 78` (EX_CONFIG, 0x4E in
# Task Scheduler) stops the run. It does not warn and continue. An ingest that
# cannot prove which database it is about to write to must not run: writing to
# the wrong one is the failure that took nine hours to notice last time, and a
# task that reports 0x4E is how a human finds out in minutes instead.
#
# ── WHY A SENTINEL AND NOT `exit` OR `throw` ────────────────────────────────
# MEASURED, 2026-08-21, not assumed. An `exit` inside a function defined in a
# DOT-SOURCED script unwinds only as far as that dot-sourced file: the calling
# wrapper carried straight on past the refusal and would have run the ingest
# anyway. A guard whose failure path is host-dependent is not a guard - it is
# the same silent fallback in a different costume. So this file contains no
# functions and no early exits: it is straight-line, it always runs to the end,
# and the ONLY contract is the $CbnewDbResolved variable it leaves in the
# caller's scope. lib/__tests__/ingestCadence.test.ts asserts every wrapper
# both dot-sources this file and checks that sentinel.
#
# ── WHY .env.cbnew AND NOT .env.local ───────────────────────────────────────
# The credential is read at run time, by EXACT key name, from the secret store
# the rebuild lane already established. It never appears on a command line, in
# a scheduled-task definition, or in a log - only the endpoint ID is logged,
# which is not a secret and is the one fact you need to answer "which database
# did that run write to?". .env.cbnew also carries a DATABASE_URL key of its
# own, so the file is never sourced wholesale; see run-rebuild-phase1.ps1,
# which established this pattern and whose logic this file generalises.
#
# Leaving .env.local alone is deliberate: the live app still reads it, and the
# cutover flip stays a separate, deliberate act rather than a side effect of an
# ingest wrapper.
# ---------------------------------------------------------------------------

param(
    # Repo root. Passed explicitly rather than derived: $PSScriptRoot semantics
    # inside a DOT-SOURCED script differ between PowerShell hosts, and a wrong
    # root here would silently look past .env.cbnew and take the refusal path
    # on a machine where nothing is actually wrong.
    [string]$Root,
    # The calling wrapper's log file, so a refusal is discoverable in the same
    # place an operator already looks. Optional; stderr is always written.
    [string]$LogPath,
    # Old, matchday-shared, quota-exhausted project. Refuse it by name even if
    # it somehow turns up under the CBNEW key.
    [string]$ForbiddenEndpoint = 'ep-shy-bread'
)

$CbnewDbResolved = $false
$cbnewDeny = $null
$cbnewUrl = $null

if (-not $Root) {
    $cbnewDeny = 'no -Root passed to _cbnew-db.ps1'
}

if (-not $cbnewDeny) {
    $cbnewFile = Join-Path $Root '.env.cbnew'
    if (-not (Test-Path $cbnewFile)) {
        $cbnewDeny = "missing $cbnewFile"
    } else {
        $cbnewLine = Select-String -Path $cbnewFile -Pattern '^CBNEW_DATABASE_URL=' |
                     Select-Object -First 1
        if (-not $cbnewLine) {
            $cbnewDeny = "CBNEW_DATABASE_URL not found in $cbnewFile"
        } else {
            $cbnewUrl = $cbnewLine.Line.Substring('CBNEW_DATABASE_URL='.Length).Trim().Trim('"').Trim("'")
        }
    }
}

if (-not $cbnewDeny -and -not $cbnewUrl) {
    $cbnewDeny = 'CBNEW_DATABASE_URL is empty'
}

# Pooled endpoint only. These walks open many short-lived connections; the
# direct endpoint runs out of them, and the resulting failure looks like flaky
# data rather than a config error.
if (-not $cbnewDeny -and ($cbnewUrl -notmatch '-pooler\.')) {
    $cbnewDeny = 'CBNEW_DATABASE_URL is not the pooled endpoint'
}

if (-not $cbnewDeny -and ($cbnewUrl -match [regex]::Escape($ForbiddenEndpoint))) {
    $cbnewDeny = "CBNEW_DATABASE_URL points at $ForbiddenEndpoint (the old, matchday-shared project)"
}

$cbnewStamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

if ($cbnewDeny) {
    $cbnewNote = "[$cbnewStamp] REFUSING TO RUN: $cbnewDeny. " +
                 'This ingest does not fall back to .env.local - see scripts/_cbnew-db.ps1.'
    if ($LogPath) { Add-Content $LogPath $cbnewNote -Encoding utf8 -ErrorAction SilentlyContinue }
    Write-Error $cbnewNote -ErrorAction Continue
} else {
    $env:DATABASE_URL = $cbnewUrl
    $CbnewDbResolved = $true

    # Log WHICH database, not the credential. Without this line the only way to
    # answer "did that run write to the rebuilt project?" is to re-derive it
    # from a file that may since have changed - which is how this went
    # unnoticed for the whole of the 2026-08-20 outage.
    $cbnewEndpoint = if ($cbnewUrl -match '@([^./]+)\.') { $Matches[1] } else { 'unknown-endpoint' }
    $cbnewNote = "[$cbnewStamp] DATABASE_URL -> $cbnewEndpoint (from .env.cbnew, CBNEW_DATABASE_URL)"
    if ($LogPath) { Add-Content $LogPath $cbnewNote -Encoding utf8 -ErrorAction SilentlyContinue }
}
