<#
  capture-live-client.ps1 -- observe Riot's in-game Live Client Data API for real.

  WHY THIS EXISTS
  ---------------
  companion.ps1's Get-LiveSkillState and lib/nextSkill.ts's resolveNextSkill were
  both written against Riot's PUBLISHED SCHEMA, not against an observed payload --
  there was no League client on the authoring machine. Every "assumed" note in
  those two files traces back to that one gap.

  This script closes it. Run it, play one Practice Tool game, and it captures the
  raw bytes those files were guessing about, then checks them against the exact
  contract they assume.

  It is READ-ONLY. Nothing but GET requests to 127.0.0.1:2999. It does not talk
  to the LCU, does not write a rune page, does not touch an item set.

  ASCII ONLY -- deliberately, same as companion.ps1. PowerShell 5.1 reads a
  BOM-less file as CP1252, where the UTF-8 em dash's third byte (0x94) becomes a
  smart quote that PowerShell accepts as a STRING DELIMITER. One em dash in a
  comment silently breaks the parse. Do not reintroduce non-ASCII here.

  USAGE
  -----
    powershell -ExecutionPolicy Bypass -File scripts\capture-live-client.ps1

  Then launch a Practice Tool game. The script waits for the game, captures a
  snapshot on every change to (level, Q, W, E, R), and prints a live verdict.
  Ctrl-C when done; a summary and a raw dump land in _capture\.

  The point is the RAW dump. A parsed PowerShell object silently normalises key
  casing, so the response body as a STRING is the only honest evidence of what
  Riot actually sends.
#>

[CmdletBinding()]
param(
    # Where the raw evidence lands. Left empty here and resolved below: under
    # PowerShell 5.1 invoked as `-File`, $PSScriptRoot is NOT yet populated when
    # param() defaults are evaluated, so computing it here yields an empty
    # string and Split-Path throws before the script body ever runs.
    [string] $OutDir = '',
    # Poll interval. 1s is fine: this is loopback, and a level-up is the one
    # event we must not miss.
    [double] $IntervalSeconds = 1.0
)

$ErrorActionPreference = 'Stop'
$BASE = 'https://127.0.0.1:2999/liveclientdata'

# Resolve the output directory now that the script body IS running and the
# automatic variables are populated. $MyInvocation.MyCommand.Path is used rather
# than $PSScriptRoot because it is set under every invocation style (-File,
# dot-source, and `iex` of a downloaded string).
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $scriptPath = $MyInvocation.MyCommand.Path
    if ([string]::IsNullOrWhiteSpace($scriptPath)) {
        # Last resort: no script path (piped in). Land next to the cwd.
        $OutDir = Join-Path (Get-Location).Path '_capture'
    } else {
        $OutDir = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptPath)) '_capture'
    }
}

# -- TLS shim, loopback-scoped ------------------------------------------------
# The in-game API serves a self-signed cert. Same policy as companion.ps1's
# Initialize-TlsShim: bypass ONLY for loopback, never a blanket accept-all. If
# this widened, it would weaken every other HTTPS call this process makes.
function Initialize-LoopbackTlsShim {
    if (-not ([System.Management.Automation.PSTypeName]'CaptureLoopbackCertPolicy').Type) {
        Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

public class CaptureLoopbackCertPolicy {
    public static void Install() {
        ServicePointManager.ServerCertificateValidationCallback =
            delegate(object sender, X509Certificate cert, X509Chain chain, SslPolicyErrors errors) {
                if (errors == SslPolicyErrors.None) return true;
                HttpWebRequest req = sender as HttpWebRequest;
                if (req == null) return false;
                string host = req.RequestUri.Host;
                // Loopback ONLY. Anything else gets real validation.
                return host == "127.0.0.1" || host == "localhost" || host == "::1";
            };
    }
}
'@
    }
    [CaptureLoopbackCertPolicy]::Install()
    [System.Net.ServicePointManager]::SecurityProtocol =
        [System.Net.SecurityProtocolType]::Tls12 -bor [System.Net.SecurityProtocolType]::Tls11
}

# Returns the RAW response body as a string, or $null when the endpoint is not
# there. "No game running" is the normal state, not an error.
function Get-RawEndpoint {
    param([string] $Path)
    try {
        $r = Invoke-WebRequest -Uri "$BASE/$Path" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -ne 200) { return $null }
        return $r.Content
    } catch {
        return $null
    }
}

# -- The contract under test --------------------------------------------------
# Exactly what companion.ps1's ConvertTo-LiveSkillState and lib/nextSkill.ts's
# parseLiveSkillState assume. Each check reports separately, so a partial match
# is legible rather than one undifferentiated FAIL.
function Test-AssumedContract {
    param([string] $ActivePlayerJson)

    $result = [ordered]@{
        parsed               = $false
        hasLevel             = $false
        levelValue           = $null
        levelIsInt1to18      = $false
        hasAbilitiesOnActive = $false
        abilityKeys          = @()
        perAbility           = [ordered]@{}
        allFourPresent       = $false
        ranksSumLeLevel      = $false
        spent                = $null
        unspent              = $null
        notes                = (New-Object System.Collections.Generic.List[string])
    }

    $obj = $null
    try {
        $obj = $ActivePlayerJson | ConvertFrom-Json
    } catch {
        $result.notes.Add('activeplayer body did not parse as JSON')
        return $result
    }
    $result.parsed = $true

    # Level. PowerShell property lookup is case-INSENSITIVE, so this check
    # cannot detect casing drift -- the raw dump is the authority on that.
    if ($null -ne $obj.level) {
        $result.hasLevel = $true
        $result.levelValue = $obj.level
        $n = 0
        if ([int]::TryParse([string]$obj.level, [ref]$n)) {
            $result.levelIsInt1to18 = ($n -ge 1 -and $n -le 18)
        }
    } else {
        $result.notes.Add("no 'level' on activeplayer -- nextSkill.ts would refuse as bad-level")
    }

    # Abilities. companion.ps1 reads this off activeplayer FIRST and only falls
    # back to /activeplayerabilities when it is absent. Which of those two
    # actually happens in a real game is one of the things we are here to learn.
    $abilities = $obj.abilities
    if ($null -ne $abilities) {
        $result.hasAbilitiesOnActive = $true
        $result.abilityKeys = @($abilities.PSObject.Properties.Name)

        $sum = 0
        $allFour = $true
        foreach ($k in @('Q', 'W', 'E', 'R')) {
            $slot = $abilities.$k
            if ($null -eq $slot) {
                $result.perAbility[$k] = 'ABSENT'
                $allFour = $false
                continue
            }
            # The assumed shape is an object carrying abilityLevel. A bare number
            # is tolerated by the companion; record which one we actually saw.
            if ($slot -is [string] -or $slot -is [int] -or $slot -is [long] -or $slot -is [double]) {
                $result.perAbility[$k] = "BARE:$slot"
                $sum += [int]$slot
            } elseif ($null -ne $slot.abilityLevel) {
                $result.perAbility[$k] = "abilityLevel=$($slot.abilityLevel)"
                $sum += [int]$slot.abilityLevel
            } else {
                $names = ($slot.PSObject.Properties.Name) -join ','
                $result.perAbility[$k] = "NO abilityLevel (keys: $names)"
                $allFour = $false
            }
        }
        $result.allFourPresent = $allFour
        if ($allFour) {
            $result.spent = $sum
            if ($result.levelIsInt1to18) {
                $lvl = [int]$obj.level
                $result.unspent = $lvl - $sum
                $result.ranksSumLeLevel = ($sum -le $lvl)
                if ($sum -gt $lvl) {
                    $result.notes.Add("ranks sum ($sum) EXCEEDS level ($lvl) -- nextSkill.ts refuses as over-spent")
                }
            }
        }
    } else {
        $result.notes.Add("no 'abilities' on activeplayer -- companion falls back to /activeplayerabilities")
    }

    return $result
}

# -- Setup --------------------------------------------------------------------
Initialize-LoopbackTlsShim

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$stamp      = Get-Date -Format 'yyyyMMdd-HHmmss'
$rawPath    = Join-Path $OutDir "live-client-raw-$stamp.jsonl"
$reportPath = Join-Path $OutDir "live-client-report-$stamp.txt"

$report = New-Object System.Collections.Generic.List[string]
function Emit {
    param([string] $Line, [string] $Colour = 'Gray')
    Write-Host $Line -ForegroundColor $Colour
    $report.Add($Line)
}

Emit 'CoachBuild -- Live Client Data capture' 'Cyan'
Emit "started    $(Get-Date -Format 'u')"
Emit "raw dump   $rawPath"
Emit "report     $reportPath"
Emit ''
Emit 'Waiting for a game on 127.0.0.1:2999 ... (start a Practice Tool game)' 'Yellow'
Emit 'Ctrl-C to stop and write the summary.' 'DarkGray'
Emit ''

# -- Wait for the game --------------------------------------------------------
$firstSeen = $null
while ($null -eq $firstSeen) {
    $firstSeen = Get-RawEndpoint -Path 'activeplayer'
    if ($null -eq $firstSeen) { Start-Sleep -Seconds 2 }
}

Emit "GAME DETECTED at $(Get-Date -Format 'u')" 'Green'
Emit ''

# One-time full capture of every endpoint, so the raw evidence is complete even
# if the session is cut short. allgamedata is large; it is captured once rather
# than per tick, and it is the authority on what else is available should the
# overlay ever need more than level and ranks.
foreach ($ep in @('activeplayer', 'activeplayerabilities', 'allgamedata', 'playerlist', 'eventdata')) {
    $body = Get-RawEndpoint -Path $ep
    $rec = [ordered]@{
        at       = (Get-Date -Format 'o')
        kind     = 'initial'
        endpoint = $ep
        ok       = ($null -ne $body)
        body     = $body
    }
    ($rec | ConvertTo-Json -Depth 6 -Compress) | Add-Content -Path $rawPath -Encoding UTF8
    if ($null -eq $body) {
        Emit "  $ep -- NO RESPONSE" 'Red'
    } else {
        Emit "  $ep -- $($body.Length) bytes captured" 'DarkGray'
    }
}
Emit ''

# The first activeplayer body is what settles the design question, so print it
# in full rather than making the user go open the dump.
$activeRaw = Get-RawEndpoint -Path 'activeplayer'
if ($null -ne $activeRaw) {
    Emit '---- RAW /activeplayer ----------------------------------------' 'Cyan'
    Emit $activeRaw
    Emit ''
}

# -- Poll loop: snapshot on every change to (level, Q, W, E, R) ---------------
$lastKey  = $null
$ticks    = 0
$captures = 0

try {
    while ($true) {
        $raw = Get-RawEndpoint -Path 'activeplayer'
        if ($null -eq $raw) {
            # Game ended (or a reconnect window). Stop rather than spin.
            Emit ''
            Emit "Game endpoint gone at $(Get-Date -Format 'u') -- game over or client closed." 'Yellow'
            break
        }

        $ticks++
        $check = Test-AssumedContract -ActivePlayerJson $raw

        $key = "$($check.levelValue)|" + (($check.perAbility.Values) -join '|')
        if ($key -ne $lastKey) {
            $lastKey = $key
            $captures++

            $rec = [ordered]@{
                at       = (Get-Date -Format 'o')
                kind     = 'change'
                endpoint = 'activeplayer'
                body     = $raw
            }
            ($rec | ConvertTo-Json -Depth 6 -Compress) | Add-Content -Path $rawPath -Encoding UTF8

            $ranks = ($check.perAbility.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' '
            $unspentTxt = 'unspent=?'
            if ($null -ne $check.unspent) { $unspentTxt = "unspent=$($check.unspent)" }
            $colour = 'Gray'
            if ($null -ne $check.unspent -and $check.unspent -gt 0) { $colour = 'Green' }

            Emit ('[{0}] level={1} {2}  {3}' -f (Get-Date -Format 'HH:mm:ss'), $check.levelValue, $ranks, $unspentTxt) $colour
            foreach ($n in $check.notes) { Emit "         ! $n" 'Red' }
        }

        Start-Sleep -Seconds $IntervalSeconds
    }
} finally {
    # -- Verdict --------------------------------------------------------------
    # Runs on Ctrl-C too, which is the normal way to end this.
    $final = $null
    if ($null -ne $activeRaw) { $final = Test-AssumedContract -ActivePlayerJson $activeRaw }

    Emit ''
    Emit '---- VERDICT on the assumed contract --------------------------' 'Cyan'
    Emit "ticks polled           $ticks"
    Emit "state changes captured $captures"

    if ($null -ne $final) {
        $vLevelKey  = 'FAIL'; if ($final.hasLevel)             { $vLevelKey  = 'PASS' }
        $vParsed    = 'FAIL'; if ($final.parsed)               { $vParsed    = 'PASS' }
        $vLevelInt  = 'FAIL'; if ($final.levelIsInt1to18)      { $vLevelInt  = 'PASS' }
        $vAbilities = 'FAIL -- fallback path in use'
        if ($final.hasAbilitiesOnActive) { $vAbilities = 'PASS' }
        $vAllFour   = 'FAIL'; if ($final.allFourPresent)       { $vAllFour   = 'PASS' }

        Emit "activeplayer parses as JSON            $vParsed"
        Emit "carries 'level'                        $vLevelKey"
        Emit "level is an int in 1..18               $vLevelInt"
        Emit "carries 'abilities' on /activeplayer   $vAbilities"
        Emit "Q/W/E/R all present with a rank        $vAllFour"
        Emit ("ability keys seen                      {0}" -f ($final.abilityKeys -join ', '))
        foreach ($kv in $final.perAbility.GetEnumerator()) {
            Emit ('  {0}: {1}' -f $kv.Key, $kv.Value)
        }
        Emit ''
        Emit 'If every line above is PASS, companion.ps1 ConvertTo-LiveSkillState and'
        Emit 'lib/nextSkill.ts parseLiveSkillState are correct against a REAL payload for'
        Emit 'the first time. Any FAIL is a real v0.65.0 bug, found before a user hit it.'
    } else {
        Emit 'No activeplayer body was ever captured -- nothing to judge.' 'Red'
    }

    $report | Set-Content -Path $reportPath -Encoding UTF8
    Write-Host ''
    Write-Host "Report written to $reportPath" -ForegroundColor Cyan
    Write-Host "Raw dump written to $rawPath" -ForegroundColor Cyan
}
