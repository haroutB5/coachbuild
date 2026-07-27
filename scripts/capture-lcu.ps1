<#
  capture-lcu.ps1 -- observe the LCU endpoints the companion WRITES to, read-only.

  WHY THIS EXISTS
  ---------------
  companion.ps1 writes to the user's League rune pages and item sets. Every
  safety rule governing those writes -- which pages count as deletable, how many
  slots are free, what fields an item-set document carries -- is currently taken
  from Riot's documentation and from scars, NOT from an observed payload. The
  2026-07-27 architecture audit ranked this the highest-value hour available:
  /lol-perks/** and /lol-item-sets/** have never been observed from this repo.

  This closes that gap so a future port (or any change to Invoke-ApplyRunes)
  can be judged against reality instead of inference.

  IT IS READ-ONLY, AND THAT IS THE WHOLE POINT.
  Only GET is ever issued. There is no code path here that can POST, PUT or
  DELETE. Do not add one. If you need to test a write, do it in companion.ps1's
  -SelfTest against its mock LCU, never against a real account.

  ASCII ONLY, deliberately -- same as companion.ps1. PowerShell 5.1 reads a
  BOM-less file as CP1252, where the UTF-8 em dash's third byte (0x94) becomes a
  smart quote that PowerShell accepts as a STRING DELIMITER. One em dash in a
  comment silently breaks the parse. Do not reintroduce non-ASCII here.

  USAGE
  -----
    powershell -ExecutionPolicy Bypass -File scripts\capture-lcu.ps1

  Requires the League CLIENT to be running. A game is NOT required -- this reads
  the client, not the game.

  PRIVACY
  -------
  The LCU exposes a live auth token, your summonerId/puuid, and your rune page
  names. The token is NEVER written to disk by this script. Identifiers are
  REDACTED in the saved dump. Page names ARE kept, because the safety rules are
  about title prefixes and are unanalysable without them -- _capture/ is
  gitignored, but do not paste the dump anywhere public without reading it.
#>

[CmdletBinding()]
param(
    [string] $OutDir = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $scriptPath = $MyInvocation.MyCommand.Path
    if ([string]::IsNullOrWhiteSpace($scriptPath)) {
        $OutDir = Join-Path (Get-Location).Path '_capture'
    } else {
        $OutDir = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptPath)) '_capture'
    }
}

# -- TLS shim, loopback-scoped -----------------------------------------------
# Mirrors companion.ps1's Initialize-TlsShim, including the two properties that
# matter and are easy to lose:
#   (1) COMPILED, not a scriptblock. .NET invokes this callback on a threadpool
#       thread with no runspace, where a PowerShell scriptblock throws. That was
#       the v1.2.2 "stuck at Phase:None" bug and it was invisible on a machine
#       with no League client, because the handshake never fired.
#   (2) LOOPBACK-SCOPED. An unrecognised sender shape falls through to STRICT
#       validation -- a type-inspection miss can only make it stricter.
function Initialize-LoopbackTlsShim {
    if (-not ([System.Management.Automation.PSTypeName]'LcuCaptureCertPolicy').Type) {
        Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

public class LcuCaptureCertPolicy {
    public static void Install() {
        ServicePointManager.ServerCertificateValidationCallback =
            delegate(object sender, X509Certificate cert, X509Chain chain, SslPolicyErrors errors) {
                Uri target = null;
                HttpWebRequest req = sender as HttpWebRequest;
                if (req != null) { target = req.RequestUri; }
                else {
                    ServicePoint sp = sender as ServicePoint;
                    if (sp != null) { target = sp.Address; }
                }
                // Unrecognised sender shape -> strict. Never looser.
                if (target == null) { return errors == SslPolicyErrors.None; }
                if (target.IsLoopback) { return true; }
                return errors == SslPolicyErrors.None;
            };
    }
}
'@
    }
    [LcuCaptureCertPolicy]::Install()
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
}

# -- LCU discovery ------------------------------------------------------------
# Same two sources companion.ps1 uses, same order: the process command line
# first, the lockfile as fallback.
function Get-LcuCredentials {
    $port = $null
    $token = $null

    try {
        $proc = Get-CimInstance Win32_Process -Filter "Name='LeagueClientUx.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($proc -and $proc.CommandLine) {
            $cl = [string]$proc.CommandLine
            if ($cl -match '--app-port=(\d+)') { $port = $Matches[1] }
            if ($cl -match '--remoting-auth-token=([^"\s]+)') { $token = $Matches[1] }
        }
    } catch {
        # CIM can fail on locked-down machines; the lockfile below still works.
    }

    if (-not $port -or -not $token) {
        $lockPaths = @(
            'C:\Riot Games\League of Legends\lockfile',
            'D:\Riot Games\League of Legends\lockfile'
        )
        foreach ($lp in $lockPaths) {
            if (Test-Path $lp) {
                try {
                    # The client holds the lockfile open; a plain Get-Content is
                    # refused, so open it share-all explicitly.
                    $fs = [System.IO.File]::Open($lp, 'Open', 'Read', 'ReadWrite')
                    $sr = New-Object System.IO.StreamReader($fs)
                    $raw = $sr.ReadToEnd()
                    $sr.Close(); $fs.Close()
                    $parts = $raw.Split(':')
                    if ($parts.Count -ge 4) { $port = $parts[2]; $token = $parts[3] }
                    break
                } catch {
                    # fall through
                }
            }
        }
    }

    if (-not $port -or -not $token) { return $null }
    return [ordered]@{ Port = $port; Token = $token }
}

# GET only. There is deliberately no method parameter.
function Invoke-LcuGet {
    param([string] $Port, [string] $Token, [string] $Path)
    $pair = "riot:$Token"
    $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
    try {
        $r = Invoke-WebRequest -Uri "https://127.0.0.1:$Port$Path" -Method GET `
            -Headers @{ Authorization = "Basic $b64"; Accept = 'application/json' } `
            -UseBasicParsing -TimeoutSec 6
        return [ordered]@{ ok = $true; status = [int]$r.StatusCode; body = $r.Content }
    } catch {
        $code = 0
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        return [ordered]@{ ok = $false; status = $code; body = $null; error = $_.Exception.Message }
    }
}

# -- Redaction ----------------------------------------------------------------
# The token is never passed here (it is never written at all). These are the
# identifiers that would otherwise land in a file on disk.
function Protect-Sensitive {
    param([string] $Json)
    if ([string]::IsNullOrEmpty($Json)) { return $Json }
    $out = $Json
    foreach ($key in @('puuid', 'accountId', 'summonerId', 'displayName', 'gameName', 'tagLine', 'internalName', 'privacy')) {
        $out = [System.Text.RegularExpressions.Regex]::Replace(
            $out, "(""$key""\s*:\s*)""[^""]*""", "`$1""[REDACTED]""")
        $out = [System.Text.RegularExpressions.Regex]::Replace(
            $out, "(""$key""\s*:\s*)\d+", "`$1000000")
    }
    return $out
}

# -- Setup --------------------------------------------------------------------
Initialize-LoopbackTlsShim
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$stamp      = Get-Date -Format 'yyyyMMdd-HHmmss'
$rawPath    = Join-Path $OutDir "lcu-raw-$stamp.jsonl"
$reportPath = Join-Path $OutDir "lcu-report-$stamp.txt"

$report = New-Object System.Collections.Generic.List[string]
function Emit {
    param([string] $Line, [string] $Colour = 'Gray')
    Write-Host $Line -ForegroundColor $Colour
    $report.Add($Line)
}

Emit 'CoachBuild -- LCU read-only capture' 'Cyan'
Emit "started  $(Get-Date -Format 'u')"
Emit "raw      $rawPath"
Emit "report   $reportPath"
Emit ''
Emit 'READ-ONLY: this script only ever issues GET. It cannot write to your account.' 'DarkGray'
Emit ''

$creds = Get-LcuCredentials
if ($null -eq $creds) {
    Emit 'League CLIENT not found.' 'Red'
    Emit 'Start the League of Legends client (you do NOT need to be in a game), then re-run.' 'Yellow'
    $report | Set-Content -Path $reportPath -Encoding UTF8
    exit 1
}
Emit "LCU found on port $($creds.Port) (auth token read, never written to disk)" 'Green'
Emit ''

# -- I-16: prove the TLS bypass is loopback-scoped ---------------------------
# The audit's open item: -SelfTest's mock LCU is plain HTTP, so it can NEVER
# reach this path. Two assertions, and BOTH must hold:
#   loopback + self-signed  -> accepted
#   non-loopback + bad cert -> STILL REJECTED
# Only the pair proves scoping. Accepting loopback alone would also be true of
# a blanket accept-all, which is exactly the bug this guards against.
Emit '---- I-16: is the TLS bypass really loopback-ONLY? ----' 'Cyan'
$probe = Invoke-LcuGet -Port $creds.Port -Token $creds.Token -Path '/lol-summoner/v1/current-summoner'
if ($probe.ok) {
    Emit '  loopback self-signed cert      ACCEPTED  (expected)' 'Green'
} else {
    Emit "  loopback self-signed cert      FAILED -- $($probe.error)" 'Red'
}
try {
    # expired.badssl.com serves a genuinely invalid cert. If the shim were a
    # blanket accept-all rather than loopback-scoped, this would succeed.
    $null = Invoke-WebRequest -Uri 'https://expired.badssl.com/' -UseBasicParsing -TimeoutSec 10
    Emit '  non-loopback BAD cert          ACCEPTED  <-- BYPASS IS TOO WIDE, THIS IS A BUG' 'Red'
} catch {
    if ($_.Exception.Message -match 'SSL|certificate|trust|secure channel') {
        Emit '  non-loopback BAD cert          REJECTED  (expected -- scoping holds)' 'Green'
    } else {
        Emit "  non-loopback BAD cert          inconclusive (network?) -- $($_.Exception.Message)" 'Yellow'
    }
}
Emit ''

# -- Capture ------------------------------------------------------------------
$summonerId = $null
$endpoints = New-Object System.Collections.Generic.List[string]
$endpoints.Add('/lol-summoner/v1/current-summoner')
$endpoints.Add('/lol-perks/v1/pages')
$endpoints.Add('/lol-perks/v1/inventory')
$endpoints.Add('/lol-perks/v1/currentpage')
$endpoints.Add('/lol-gameflow/v1/gameflow-phase')

$bodies = @{}
foreach ($ep in $endpoints) {
    $res = Invoke-LcuGet -Port $creds.Port -Token $creds.Token -Path $ep
    $bodies[$ep] = $res
    $rec = [ordered]@{
        at       = (Get-Date -Format 'o')
        endpoint = $ep
        ok       = $res.ok
        status   = $res.status
        body     = (Protect-Sensitive -Json $res.body)
    }
    ($rec | ConvertTo-Json -Depth 8 -Compress) | Add-Content -Path $rawPath -Encoding UTF8
    if ($res.ok) {
        Emit ("  {0,-42} {1} bytes" -f $ep, $res.body.Length) 'DarkGray'
    } else {
        Emit ("  {0,-42} FAILED status={1}" -f $ep, $res.status) 'Red'
    }
}

# Item sets are addressed by the user's OWN summonerId -- read it solely for
# that, exactly as companion.ps1 does, and never render it.
if ($bodies['/lol-summoner/v1/current-summoner'].ok) {
    try { $summonerId = ($bodies['/lol-summoner/v1/current-summoner'].body | ConvertFrom-Json).summonerId } catch { }
}
if ($summonerId) {
    $ep = "/lol-item-sets/v1/item-sets/$summonerId/sets"
    $res = Invoke-LcuGet -Port $creds.Port -Token $creds.Token -Path $ep
    $bodies['itemsets'] = $res
    $rec = [ordered]@{
        at       = (Get-Date -Format 'o')
        endpoint = '/lol-item-sets/v1/item-sets/{summonerId}/sets'
        ok       = $res.ok
        status   = $res.status
        body     = (Protect-Sensitive -Json $res.body)
    }
    ($rec | ConvertTo-Json -Depth 12 -Compress) | Add-Content -Path $rawPath -Encoding UTF8
    if ($res.ok) {
        Emit ("  {0,-42} {1} bytes" -f '/lol-item-sets/.../sets', $res.body.Length) 'DarkGray'
    } else {
        Emit ("  {0,-42} FAILED status={1}" -f '/lol-item-sets/.../sets', $res.status) 'Red'
    }
}
Emit ''

# -- The questions the audit actually asked -----------------------------------
Emit '---- ANSWERS (this is why we ran it) ----' 'Cyan'

# I-9 / Divergences 2 and 3: do preset pages appear, and with what flags?
if ($bodies['/lol-perks/v1/pages'].ok) {
    $pages = $bodies['/lol-perks/v1/pages'].body | ConvertFrom-Json
    $all = @($pages)
    $deletableTrue  = @($all | Where-Object { $_.isDeletable -eq $true })
    $deletableFalse = @($all | Where-Object { $_.isDeletable -eq $false })
    $deletableMissing = @($all | Where-Object { $null -eq $_.isDeletable })
    Emit "rune pages returned            $($all.Count)"
    Emit "  isDeletable = true           $($deletableTrue.Count)   <- what companion.ps1 counts (I-9)"
    Emit "  isDeletable = false          $($deletableFalse.Count)   <- presets; must NEVER count toward the cap"
    Emit "  isDeletable ABSENT           $($deletableMissing.Count)   <- if >0, the TS port's 'isDeletable !== false' was WIDER than PowerShell's '-eq true'"
    Emit '  titles (prefix rules operate on these):'
    foreach ($p in $all) {
        Emit ("    [{0,-5}] {1}" -f $(if ($p.isDeletable -eq $true) { 'del' } else { 'PRESET' }), $p.name)
    }
} else {
    Emit 'rune pages                     UNAVAILABLE' 'Red'
}

if ($bodies['/lol-perks/v1/inventory'].ok) {
    try {
        $inv = $bodies['/lol-perks/v1/inventory'].body | ConvertFrom-Json
        Emit "ownedPageCount                 $($inv.ownedPageCount)   <- the cap the deletable count is compared against"
    } catch { Emit 'inventory                      unparseable' 'Red' }
}

# I-13 / I-15: what does the item-set document actually carry, and how big?
if ($bodies.ContainsKey('itemsets') -and $bodies['itemsets'].ok) {
    try {
        $sets = $bodies['itemsets'].body | ConvertFrom-Json
        $topKeys = ($sets.PSObject.Properties.Name) -join ', '
        Emit ''
        Emit "item-set document size         $($bodies['itemsets'].body.Length) bytes  <- CLAUDE.md claims a 4KB budget; that figure is UNSOURCED"
        Emit "item-set top-level fields      $topKeys"
        Emit '  ^ Merge-ItemSets must pass ALL of these through untouched (I-13) --'
        Emit '    the PUT replaces the WHOLE document, so a dropped field is data loss.'
        $existing = @($sets.itemSets)
        $ours = @($existing | Where-Object { $_.title -and ([string]$_.title).StartsWith('CoachBuild') })
        Emit "  itemSets total               $($existing.Count)"
        Emit "  ours (CoachBuild*)           $($ours.Count)   <- pruned to O(1) on every write (I-14)"
        Emit "  the user's own              $($existing.Count - $ours.Count)   <- must survive byte-for-byte"
    } catch { Emit 'item sets unparseable' 'Red' }
}

Emit ''
Emit 'Raw bodies (identifiers redacted, auth token never written) are in the .jsonl.'
Emit 'These answers are what a future port must be judged against -- they are now'
Emit 'OBSERVED, where before they were inferred from documentation.'

$report | Set-Content -Path $reportPath -Encoding UTF8
Write-Host ''
Write-Host "Report written to $reportPath" -ForegroundColor Cyan
Write-Host "Raw dump written to $rawPath" -ForegroundColor Cyan
