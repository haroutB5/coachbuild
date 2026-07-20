#requires -Version 5.1
<#
================================================================================
 CoachBuild Live Companion
================================================================================

COMPLIANCE BRIGHT LINES (product law -- do not cross, ever):
  - NEVER compute or surface enemy ability/summoner cooldowns or ultimate
    timers (banned by Riot, Mar 13 2025).
  - NEVER automate game actions: no auto-accept, auto-pick, auto-lock,
    auto-dodge. This companion only READS state and opens a browser tab.
  - NEVER reveal non-party summoner names during champ select (Patch 12.22
    anonymity). Champ-select reads ONLY championId / championPickIntent /
    session.actions (own-action championId, own actorCellId only) /
    assignedPosition -- never summonerId or any name field.
  - GET /lol-summoner/v1/current-summoner (item-sets flow) reads only the
    LOCAL USER'S OWN summonerId, purely to address their own
    /lol-item-sets/v1/item-sets/{id}/sets -- never another player's identity,
    never surfaced anywhere, never logged.
  - Rune-page apply happens ONLY via a user-clicked button on the web app
    (POST /apply-runes) -- runes stay STRICTLY manual, never auto-exported.
  - Item-SET writes (POST /apply-itemsets) are inert shop-panel suggestions
    (same class as Blitz/u.gg's auto-import; compliance-fine, not gameplay
    automation) -- these MAY be exported automatically on a champ-select
    deep-link (opt-out toggle, /live-setup), unlike runes. The distinction:
    an item set is a passive shopping suggestion the player still chooses
    item-by-item in the store; it does not act in the game on the player's
    behalf the way an auto-pick/auto-lock would.
  - /live is a raw, unmodified passthrough of the official Live Client Data
    API (127.0.0.1:2999). No cooldown/timer/power-spike computation here or
    anywhere downstream in this repo.
  - companion.log (see LOGGING below) never writes the session token or any
    summoner/player name -- state transitions and outcomes only.

WIRE CONTRACT (must match components/live/companionClient.ts exactly):
  - Bridge listens on 127.0.0.1, first free port of [48291, 48292, 48293].
  - CORS: Access-Control-Allow-Origin is the exact AppOrigin string
    (https://coachbuild.vercel.app), Allow-Headers "content-type",
    Allow-Methods "GET,POST,OPTIONS", Max-Age 600. OPTIONS -> 204.
  - Origin header must equal AppOrigin exactly on every request (incl.
    OPTIONS) or the request is rejected with 403 {error:"bad-origin"}.
  - Every non-OPTIONS request must carry ?session=<token> matching this
    companion's session; otherwise 403 {error:"bad-session"}.
  - GET  /status       -> 200 {version:string, port:number, phase:string,
                                clientConnected:boolean,
                                lastOpen:{championId,roleId|null,at}|null,
                                champSelect:{localPlayerCellId,
                                  cellChampionId|null, pickIntent|null,
                                  actionChampionId|null, roleId|null}|null
                                  (null outside phase=="ChampSelect")}
  - GET  /live         -> 200 <raw allgamedata JSON> | 200 {error:"no-live"}
  - POST /apply-runes  body {name, primaryStyleId, subStyleId,
                              selectedPerkIds:number[9], current:true}
                       -> 200 {ok:true}
                        | 200 {ok:false, reason:string, hint?:string}
  - POST /apply-itemsets body {championId:int, sets:ItemSet[] (1-3, each
                                title MUST start with "CoachBuild" -- the
                                bridge validates this defensively and
                                rejects otherwise, never writing a
                                non-CoachBuild-titled set)}
                       -> 200 {ok:true, count:number}
                        | 200 {ok:false, reason:string, hint?:string}
    Merge semantics (PUT to /lol-item-sets/v1/item-sets/{id}/sets REPLACES
    THE ENTIRE object -- the #1 correctness risk): GET the full existing
    sets object first; NEVER PUT on a failed GET (-> {ok:false,
    reason:'read-failed'}); keep every existing set whose title does NOT
    start with THIS champ+role's "CoachBuild <champ> <role>" prefix (so a
    CoachBuild set for a DIFFERENT champion/role accumulates across
    sessions rather than being wiped); replace (not duplicate) stale sets
    for the same champ+role; PUT back every other top-level field
    (accountId, timestamp, etc.) byte-for-byte untouched.
  - Champ-select flow is ZERO-BRIDGE: the companion opens
    "<AppOrigin>/?championId=<id>[&role=<0-4>]&session=<token>" directly via
    Start-Process. `role` is OMITTED (not a bogus value) when
    assignedPosition is blank/unmapped (custom lobbies, blind pick, ARAM) --
    v1.1.0 silently skipped opening entirely in that case (a live-reported
    bug); v1.2.0 still opens, just without a role, and the web side falls
    back to its own most-played-lane resolution. RoleId map: top=0
    jungle=1 middle=2 bottom=3 utility=4 (LCU assignedPosition strings ->
    numeric RoleId; "" / unmapped = omit `role`). Champion resolution is a
    3-way fallback (real-client evidence: a pre-lock hover often isn't
    reflected on the cell at all): (1) cell championId if locked, (2) cell
    championPickIntent if set, (3) scan session.actions (array OF ARRAYS --
    flatten both levels) for the local player's own in-progress 'pick'
    action.

LOGGING (diagnosability -- remote-debugging without a screen-share):
  - Rolling log at %LOCALAPPDATA%\CoachBuild\companion.log: one line per
    phase transition, champ-select open (role or role-less), apply-runes/
    apply-itemsets result, and internal error. Capped ~200KB -- truncates to
    the newest half when exceeded, so a long session never grows it
    unbounded. Fail-soft: a logging failure (locked file, full disk) never
    takes down the companion. Never logs the session token or any name.

PS 5.1 GOTCHAS (why this script looks the way it does):
  - No -SkipCertificateCheck on Invoke-WebRequest/Invoke-RestMethod in PS5.1
    -> TLS shim below forces TLS1.2 + a ServerCertificateValidationCallback.
  - ConvertTo-Json default -Depth is 2 (truncates nested LCU/live JSON) ->
    always pass -Depth 10. Bridge responses use -Compress.
  - WMIC is deprecated/removed on newer Win11 -> Get-CimInstance, not WMIC.
  - Win32_Process.CommandLine can be $null -> guard before regex-matching.
  - .NET 4.x ClientWebSocket (PS5.1's WS story) can't do a per-connection
    cert callback -> WS against the LCU's self-signed cert is a dead end;
    champ-select uses 1s session polling instead (see decisions, plan §7).
  - HttpListener on 127.0.0.1 needs no netsh URL ACL (loopback-only bind).
  - WinForms NotifyIcon needs an STA thread; Windows PowerShell's console
    host is STA by default, so the tray + polling timer live on the main
    thread's message loop (Application.Run), while the HttpListener bridge
    runs on a background runspace (GetContextAsync blocks, would freeze the
    UI message loop if run inline).
  - LCU JSON numbers (e.g. rune page id) may deserialize as Int64 -- string
    interpolation into URLs/paths handles this fine without explicit casts,
    but don't assume Int32 if you ever do arithmetic on them.

================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$SelfTest,
    [switch]$Mock,
    [switch]$Once,
    [int]$TimeoutSec = 15
)

#region Config
$script:Config = @{
    Version     = '1.2.0'
    AppOrigin   = 'https://coachbuild.vercel.app'
    BridgePorts = @(48291, 48292, 48293)
    PollMs      = 1500
    LivePollMs  = 1000
    # Per-launch fallback only -- Start-Companion / Install-Companion both
    # overwrite this with the persistent token from Get-OrCreateSessionToken
    # before it's used for real. -SelfTest/-Mock pass their own explicit
    # tokens and never touch this value or the on-disk file.
    Session     = ([guid]::NewGuid().ToString('N'))
}
$script:MockMode = $false
#endregion

#region SessionToken
function Get-OrCreateSessionToken {
    # Session used to be purely per-launch (a fresh GUID every time the
    # companion started), which meant pairing (/live-setup Test Connection)
    # was only reachable via a champ-select deep-link -- impossible to test
    # before ever entering champ select. Persisting the token means: (a) the
    # browser's already-stored session (localStorage, companionClient.ts)
    # stays valid across companion restarts, and (b) -Install can open the
    # pairing page immediately with a real, durable token. Falls back to a
    # per-launch GUID on any IO failure (read-only profile, locked file,
    # AV interference, etc.) -- never blocks startup over this.
    param([string]$BaseDir = (Join-Path $env:LOCALAPPDATA 'CoachBuild'))
    $path = Join-Path $BaseDir 'companion-session.txt'
    try {
        if (-not (Test-Path $BaseDir)) { New-Item -ItemType Directory -Path $BaseDir -Force | Out-Null }
        if (Test-Path $path) {
            $existing = (Get-Content -Path $path -Raw -ErrorAction Stop).Trim()
            if ($existing) { return $existing }
        }
        $token = [guid]::NewGuid().ToString('N')
        Set-Content -Path $path -Value $token -NoNewline -Encoding ASCII -ErrorAction Stop
        return $token
    } catch {
        return [guid]::NewGuid().ToString('N')
    }
}
#endregion

#region SingleInstance
function Test-SingleInstance {
    $createdNew = $false
    $script:CompanionMutex = New-Object System.Threading.Mutex($true, 'Local\CoachBuildCompanion', [ref]$createdNew)
    return $createdNew
}
#endregion

#region TlsShim
function Initialize-TlsShim {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
    # PS 5.1 has no -SkipCertificateCheck; the LCU + Live Client Data APIs
    # both serve self-signed loopback certs, so accept-all is the only path.
    [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}
#endregion

#region SharedFunctions
# Defined once as source text so both the main thread AND every background
# runspace (bridge server, mock LCU) get identical implementations without
# duplicating logic -- see Start-BridgeServer / Start-MockLcu for how this
# is injected into a new runspace via AddScript.
$script:SharedFunctionsSrc = @'
function ConvertTo-BasicAuthHeader {
    param([string]$Token)
    $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("riot:$Token"))
    return "Basic $b64"
}

function Invoke-LcuRaw {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Path,
        $Body,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][string]$Token,
        [int]$TimeoutSec = 5,
        # Real LCU is always https (self-signed, TLS shim handles it). Test
        # seam only: Invoke-SelfTest's mock LCU is a plain HttpListener (no
        # cert to bind), so it passes 'http' here -- production code paths
        # never set this and get the real https scheme.
        [string]$Scheme = 'https'
    )
    $headers = @{ Authorization = (ConvertTo-BasicAuthHeader -Token $Token) }
    $uri = "${Scheme}://127.0.0.1:$Port$Path"
    $params = @{ Uri = $uri; Method = $Method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = $TimeoutSec }
    if ($null -ne $Body) {
        # Byte array, NOT a plain string: Invoke-WebRequest's string-body
        # path silently downgrades non-ASCII characters to the console's
        # best-fit OEM codepage before sending (e.g. a real em-dash in an
        # item-set title -> a plain hyphen) unless it's given already-
        # encoded bytes -- found live when an item-set title round-tripped
        # through Invoke-LcuRaw's PUT came back corrupted in SelfTest.
        # Encoding it ourselves here sidesteps that entirely, for BOTH
        # rune bodies (ASCII today, but not guaranteed forever) and item-set
        # bodies (titles carry a real em-dash from itemSetBody.ts).
        $json = $Body | ConvertTo-Json -Depth 10 -Compress
        $params.Body = [Text.Encoding]::UTF8.GetBytes($json)
        $params.ContentType = 'application/json'
    }
    try {
        $res = Invoke-WebRequest @params
        $content = $null
        if ($res.Content) {
            try { $content = $res.Content | ConvertFrom-Json } catch { $content = $res.Content }
        }
        return [pscustomobject]@{ Ok = $true; StatusCode = [int]$res.StatusCode; Content = $content }
    } catch {
        $status = 0
        try { if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode } } catch {}
        return [pscustomobject]@{ Ok = $false; StatusCode = $status; Content = $null }
    }
}

function Get-LiveClientData {
    try {
        return Invoke-RestMethod -Uri 'https://127.0.0.1:2999/liveclientdata/allgamedata' -UseBasicParsing -TimeoutSec 3
    } catch {
        return $null
    }
}

function Set-CorsHeaders {
    param($Response, [string]$AppOrigin)
    $Response.Headers.Add('Access-Control-Allow-Origin', $AppOrigin)
    $Response.Headers.Add('Access-Control-Allow-Headers', 'content-type')
    $Response.Headers.Add('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    $Response.Headers.Add('Access-Control-Max-Age', '600')
}

function Write-JsonResponse {
    param($Response, [int]$StatusCode, $Obj)
    $json = $Obj | ConvertTo-Json -Depth 10 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $Response.StatusCode = $StatusCode
    $Response.ContentType = 'application/json'
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Invoke-ApplyRunes {
    # Importer pattern: GET current page -> DELETE it -> POST the new page.
    # Bug #1013 (RiotGames/developer-relations): DELETE on an isDeletable
    # page can falsely fail -- fail SOFT here (never attempt the POST after
    # a failed delete) and surface a manual-delete hint instead of retrying
    # or forcing anything.
    param($Body, [int]$LcuPort, [string]$LcuToken, [string]$Scheme = 'https')
    $current = Invoke-LcuRaw -Method GET -Path '/lol-perks/v1/currentpage' -Port $LcuPort -Token $LcuToken -Scheme $Scheme
    if ($current.Ok -and $current.Content -and $current.Content.id) {
        $del = Invoke-LcuRaw -Method DELETE -Path "/lol-perks/v1/pages/$($current.Content.id)" -Port $LcuPort -Token $LcuToken -Scheme $Scheme
        if (-not $del.Ok) {
            return [pscustomobject]@{ ok = $false; reason = 'delete-failed'; hint = 'delete a rune page manually and retry' }
        }
    }
    $post = Invoke-LcuRaw -Method POST -Path '/lol-perks/v1/pages' -Body $Body -Port $LcuPort -Token $LcuToken -Scheme $Scheme
    if (-not $post.Ok) {
        return [pscustomobject]@{ ok = $false; reason = 'create-failed' }
    }
    return [pscustomobject]@{ ok = $true }
}

function Write-CompanionLog {
    # Rolling diagnostic log -- see header comment's LOGGING section. Shared
    # so both the main thread (phase transitions, champ-select opens) and
    # the bridge runspace (apply-runes/apply-itemsets results, errors) write
    # through the same implementation. Never logs the session token or any
    # name -- callers pass already-safe messages only.
    param([string]$Message)
    try {
        $dir = Join-Path $env:LOCALAPPDATA 'CoachBuild'
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $logPath = Join-Path $dir 'companion.log'
        if (Test-Path $logPath) {
            $info = Get-Item -Path $logPath -ErrorAction SilentlyContinue
            if ($info -and $info.Length -gt 200KB) {
                $existing = Get-Content -Path $logPath -Raw -ErrorAction SilentlyContinue
                if ($existing) {
                    $half = [Math]::Floor($existing.Length / 2)
                    Set-Content -Path $logPath -Value $existing.Substring($half) -NoNewline -Encoding UTF8 -ErrorAction SilentlyContinue
                }
            }
        }
        $line = "$((Get-Date).ToUniversalTime().ToString('o')) $Message"
        Add-Content -Path $logPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {
        # Logging must never take down the companion.
    }
}

function Test-ItemSetsPayload {
    # Defense-in-depth (SelfTest-pinned): every incoming set's title MUST
    # start with "CoachBuild" -- the bridge refuses to write anything else,
    # so a compromised/buggy web client can never smuggle an arbitrarily
    # titled set into the user's client via this endpoint. 1-3 sets only
    # ("top 3 if available" -- the web side never sends more, but the bridge
    # doesn't trust that on its own either).
    param($Sets)
    $arr = @($Sets)
    if ($arr.Count -lt 1 -or $arr.Count -gt 3) { return $false }
    foreach ($s in $arr) {
        if (-not $s -or -not $s.title) { return $false }
        if (-not ([string]$s.title).StartsWith('CoachBuild')) { return $false }
    }
    return $true
}

function Merge-ItemSets {
    # PUT REPLACES THE ENTIRE item-sets object -- the #1 correctness risk
    # (plan finding). Never blind-PUT: every other top-level field on the
    # GET'd object (accountId, timestamp, whatever else the client emits)
    # passes through UNTOUCHED; only .itemSets is rebuilt. Keeps every
    # existing set whose title does NOT start with THIS champ+role's
    # CoachBuild prefix -- a CoachBuild set for a DIFFERENT champion/role
    # accumulates across sessions (the whole point of per-champ+role
    # titles) instead of being wiped by an unrelated update; only stale
    # versions of THIS exact champ+role are replaced, not duplicated.
    param($ExistingSetsObject, $NewSets)
    $newArr = @($NewSets)
    # NOTE: matches the U+2014 EM DASH via a \uXXXX regex escape, NEVER a
    # literal non-ASCII byte in this file's own source -- this script has no
    # reliable BOM/encoding guarantee served over irm|iex (a literal
    # non-ASCII char here previously broke this file's OWN tokenizer under a
    # misdetected codepage). The title strings THEMSELVES (JSON sent from
    # the web side at runtime, e.g. "CoachBuild Viktor Mid <U+2014> Core")
    # still carry a real em dash -- this escape matches it fine.
    $prefix = ([string]$newArr[0].title) -replace ('\s+' + [char]0x2014 + '.*$'), ''
    $rawExisting = $ExistingSetsObject.itemSets
    $existingArr = if ($rawExisting) { @($rawExisting) } else { @() }
    $kept = @($existingArr | Where-Object { -not ([string]$_.title).StartsWith($prefix) })
    $merged = $kept + $newArr
    $result = $ExistingSetsObject.PSObject.Copy()
    $result | Add-Member -NotePropertyName itemSets -NotePropertyValue $merged -Force
    return $result
}

function Invoke-ApplyItemSets {
    # Importer pattern (community-standard, same shape runeApplyBody's LCU
    # flow uses): GET current-summoner -> GET existing sets -> merge ->
    # PUT. NEVER PUT on a failed read at any step (that would either target
    # the wrong summoner or wipe sets we never actually read).
    param($Sets, [int]$LcuPort, [string]$LcuToken, [string]$Scheme = 'https')
    if (-not (Test-ItemSetsPayload -Sets $Sets)) {
        return [pscustomobject]@{ ok = $false; reason = 'invalid-sets'; hint = 'each set title must start with "CoachBuild" (1-3 sets)' }
    }
    $summoner = Invoke-LcuRaw -Method GET -Path '/lol-summoner/v1/current-summoner' -Port $LcuPort -Token $LcuToken -Scheme $Scheme
    if (-not $summoner.Ok -or -not $summoner.Content -or -not $summoner.Content.summonerId) {
        return [pscustomobject]@{ ok = $false; reason = 'read-failed'; hint = 'could not read the current summoner -- nothing was changed' }
    }
    $summonerId = $summoner.Content.summonerId
    $existing = Invoke-LcuRaw -Method GET -Path "/lol-item-sets/v1/item-sets/$summonerId/sets" -Port $LcuPort -Token $LcuToken -Scheme $Scheme
    if (-not $existing.Ok -or -not $existing.Content) {
        return [pscustomobject]@{ ok = $false; reason = 'read-failed'; hint = 'could not read existing item sets -- nothing was changed' }
    }
    $merged = Merge-ItemSets -ExistingSetsObject $existing.Content -NewSets $Sets
    $put = Invoke-LcuRaw -Method PUT -Path "/lol-item-sets/v1/item-sets/$summonerId/sets" -Body $merged -Port $LcuPort -Token $LcuToken -Scheme $Scheme
    if (-not $put.Ok) {
        return [pscustomobject]@{ ok = $false; reason = 'write-failed' }
    }
    return [pscustomobject]@{ ok = $true; count = @($Sets).Count }
}
'@
Invoke-Expression $script:SharedFunctionsSrc
#endregion

#region LcuDiscovery
function Get-LcuCredentials {
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='LeagueClientUx.exe'" -ErrorAction Stop)
    } catch {
        $procs = @()
    }
    foreach ($proc in $procs) {
        $cmd = $proc.CommandLine
        if (-not $cmd) { continue }  # CommandLine can be $null -- guard required
        $portMatch = [regex]::Match($cmd, '--app-port=(\d+)')
        $tokenMatch = [regex]::Match($cmd, '--remoting-auth-token=([^"\s]+)')
        if ($portMatch.Success -and $tokenMatch.Success) {
            return [pscustomobject]@{
                Port   = [int]$portMatch.Groups[1].Value
                Token  = $tokenMatch.Groups[1].Value
                Source = 'cim'
            }
        }
    }

    # Fallback: lockfile format is LeagueClient:PID:PORT:PASSWORD:https
    $lockfilePath = 'C:\Riot Games\League of Legends\lockfile'
    if (Test-Path $lockfilePath) {
        try {
            $fields = (Get-Content $lockfilePath -Raw -ErrorAction Stop).Trim().Split(':')
            if ($fields.Count -ge 5) {
                return [pscustomobject]@{
                    Port   = [int]$fields[2]
                    Token  = $fields[3]
                    Source = 'lockfile'
                }
            }
        } catch {}
    }

    return $null
}
#endregion

#region ChampSelect
function Get-RoleIdFromPosition {
    param([string]$Position)
    switch ($Position) {
        'top'     { return 0 }
        'jungle'  { return 1 }
        'middle'  { return 2 }
        'bottom'  { return 3 }
        'utility' { return 4 }
        default   { return $null }  # blank ("") or unmapped (e.g. ARAM) -- skip
    }
}

function Get-MyChampSelectCell {
    param($Session)
    if (-not $Session -or -not $Session.myTeam) { return $null }
    foreach ($m in @($Session.myTeam)) {
        if ($m.cellId -eq $Session.localPlayerCellId) { return $m }
    }
    return $null
}

function Get-DeepLinkUrl {
    # RoleId is nullable: $null means a role-LESS link (blank/unmapped
    # assignedPosition -- custom lobbies, blind pick, ARAM) -- `role` is
    # OMITTED entirely rather than sent as a bogus value; the web side falls
    # back to its own most-played-lane resolution for these (deepLink.ts).
    param([string]$AppOrigin, [string]$SessionToken, [int]$ChampionId, $RoleId)
    if ($null -ne $RoleId) {
        return "$AppOrigin/?championId=$ChampionId&role=$RoleId&session=$SessionToken"
    }
    return "$AppOrigin/?championId=$ChampionId&session=$SessionToken"
}

function Open-CompanionUrl {
    # Testable seam: -Mock records opens instead of actually launching a
    # browser, so debounce/deep-link logic is asserted without a real
    # League client or browser on this machine.
    param([string]$Url)
    if ($script:MockMode) {
        [void]$script:OpenActions.Add($Url)
    } else {
        try { Start-Process $Url | Out-Null } catch {}
    }
}

function Reset-ChampSelectState {
    param($State)
    $State.LastOpenedChampId = $null
    $State.LastOpenedRoleId = $null
}

function Get-ChampSelectActionChampionId {
    # session.actions is an array OF ARRAYS (one inner array per champ-select
    # action phase) -- flatten both levels. Live-client evidence (draft-style
    # bot lobby, companion paired, /status green): a PRE-lock hover often
    # isn't reflected in myTeam[].championPickIntent at all on some client
    # versions -- the hovered champion instead lives in the local player's
    # own in-progress 'pick' action here. Looks for MY OWN action only
    # (actorCellId == LocalCellId, type == 'pick', championId > 0); prefers
    # one still in progress (completed=false -- the freshest signal, a live
    # hover) over an already-completed one. Returns 0 (never null) when
    # nothing resolves -- this region's 0-means-"nothing yet" convention.
    param($Session, $LocalCellId)
    $candidates = @()
    foreach ($row in @($Session.actions)) {
        foreach ($action in @($row)) {
            if (-not $action) { continue }
            if ($action.actorCellId -ne $LocalCellId) { continue }
            if ($action.type -ne 'pick') { continue }
            $cid = [int]($action.championId)
            if ($cid -gt 0) {
                $candidates += [pscustomobject]@{ ChampionId = $cid; Completed = [bool]$action.completed }
            }
        }
    }
    $inProgress = @($candidates | Where-Object { -not $_.Completed })
    if ($inProgress.Count -gt 0) { return $inProgress[0].ChampionId }
    if ($candidates.Count -gt 0) { return $candidates[0].ChampionId }
    return 0
}

function Set-ChampSelectSnapshot {
    # Diagnostic snapshot for /status's `champSelect` field (remote
    # debugging without a screen-share) -- updated on EVERY poll while in
    # ChampSelect, not just on an open, so a pre-lock hover state is visible
    # even before any open decision is made. Writes into the BRIDGE's own
    # synchronized Sync (a different runspace) when a real bridge exists;
    # no-ops safely in -Mock (no bridge is ever started there).
    param([int]$LocalPlayerCellId, [int]$CellChampionId, [int]$PickIntent, [int]$ActionChampionId, $RoleId)
    $snapshot = @{
        localPlayerCellId = $LocalPlayerCellId
        cellChampionId    = $(if ($CellChampionId -gt 0) { $CellChampionId } else { $null })
        pickIntent        = $(if ($PickIntent -gt 0) { $PickIntent } else { $null })
        actionChampionId  = $(if ($ActionChampionId -gt 0) { $ActionChampionId } else { $null })
        roleId            = $RoleId
    }
    if ($script:Bridge -and $script:Bridge.Sync) {
        $script:Bridge.Sync.ChampSelectSnapshot = $snapshot
    }
    $script:ChampSelectSnapshotRecord = $snapshot
}

function Set-LastOpen {
    # /status's `lastOpen` field -- the most recent deep-link this companion
    # has opened THIS launch (null until the first one). Same cross-runspace
    # write pattern as Set-ChampSelectSnapshot above.
    param([int]$ChampionId, $RoleId)
    $entry = @{
        championId = $ChampionId
        roleId     = $RoleId
        at         = (Get-Date).ToUniversalTime().ToString('o')
    }
    if ($script:Bridge -and $script:Bridge.Sync) {
        $script:Bridge.Sync.LastOpen = $entry
    }
    $script:LastOpenRecord = $entry
}

function Update-ChampSelectState {
    # Debounce rule (plan §1): open once per champ-select, re-open ONLY on
    # an actual championId change. Never reopen on a timer tick or a
    # teammate's action -- Reset-ChampSelectState is the only thing allowed
    # to clear LastOpenedChampId, and it's called only on ChampSelect ENTRY.
    param($State, $Session, [string]$AppOrigin, [string]$SessionToken)
    $cell = Get-MyChampSelectCell -Session $Session
    if (-not $cell) { return }

    $localCellId = $Session.localPlayerCellId
    $cellChampionId = [int]$cell.championId
    $pickIntent = [int]$cell.championPickIntent
    $actionChampionId = Get-ChampSelectActionChampionId -Session $Session -LocalCellId $localCellId
    $roleId = Get-RoleIdFromPosition -Position $cell.assignedPosition

    Set-ChampSelectSnapshot -LocalPlayerCellId $localCellId -CellChampionId $cellChampionId -PickIntent $pickIntent -ActionChampionId $actionChampionId -RoleId $roleId

    # 3-way champion resolution, in priority order: (1) locked cell
    # championId, (2) cell championPickIntent (some client versions DO
    # reflect a hover here), (3) session.actions (the fallback that closes
    # the live-reported "hovering opens nothing" bug -- see
    # Get-ChampSelectActionChampionId's own header).
    $champId = $cellChampionId
    if ($champId -le 0) { $champId = $pickIntent }
    if ($champId -le 0) { $champId = $actionChampionId }
    if ($champId -le 0) { return }  # nothing hovered or locked yet, in any of the 3 sources

    # NOTE (v1.2.0 fix): this used to `return` here when $roleId was $null
    # (blank/unmapped assignedPosition) -- silently never opening for
    # custom lobbies, blind pick, or ARAM. Get-DeepLinkUrl now accepts a
    # null RoleId and simply omits `role=` from the URL instead.
    if ($State.LastOpenedChampId -eq $champId) { return }  # no change -- debounce

    $State.LastOpenedChampId = $champId
    $State.LastOpenedRoleId = $roleId
    $url = Get-DeepLinkUrl -AppOrigin $AppOrigin -SessionToken $SessionToken -ChampionId $champId -RoleId $roleId
    Open-CompanionUrl -Url $url
    Set-LastOpen -ChampionId $champId -RoleId $roleId
    Write-CompanionLog "champ-select open: champ=$champId role=$(if ($null -ne $roleId) { $roleId } else { 'none' })"
}
#endregion

#region GameflowPoll
function Invoke-GameflowTick {
    $creds = Get-LcuCredentials  # re-read every loop -- port/token rotate per client restart

    if ($creds) {
        $script:Bridge.Sync.LcuPort = $creds.Port
        $script:Bridge.Sync.LcuToken = $creds.Token
    } else {
        $script:Bridge.Sync.LcuPort = $null
        $script:Bridge.Sync.LcuToken = $null
    }

    $phase = 'None'
    if ($creds) {
        $r = Invoke-LcuRaw -Method GET -Path '/lol-gameflow/v1/gameflow-phase' -Port $creds.Port -Token $creds.Token
        if ($r.Ok -and $r.Content) { $phase = [string]$r.Content }
    }
    if ($phase -ne $script:LastLoggedPhase) {
        Write-CompanionLog "phase: $script:LastLoggedPhase -> $phase"
        $script:LastLoggedPhase = $phase
    }
    $script:Bridge.Sync.Phase = $phase

    if ($phase -eq 'ChampSelect') {
        if (-not $script:WasChampSelect) { Reset-ChampSelectState -State $script:ChampSelectState }
        $script:WasChampSelect = $true
        if ($creds) {
            $sessRaw = Invoke-LcuRaw -Method GET -Path '/lol-champ-select/v1/session' -Port $creds.Port -Token $creds.Token
            if ($sessRaw.Ok) {
                Update-ChampSelectState -State $script:ChampSelectState -Session $sessRaw.Content -AppOrigin $script:Config.AppOrigin -SessionToken $script:Config.Session
            }
        }
    } else {
        $script:WasChampSelect = $false
    }
}
#endregion

#region BridgeServer
$script:BridgeWorkerSrc = @'
while ($Sync.Running) {
    if (-not $Sync.Listener.IsListening) { Start-Sleep -Milliseconds 100; continue }
    $context = $null
    try {
        $contextTask = $Sync.Listener.GetContextAsync()
        while (-not $contextTask.Wait(200)) {
            if (-not $Sync.Running) { return }
        }
        $context = $contextTask.Result
    } catch {
        continue
    }
    if (-not $context) { continue }

    $req = $context.Request
    $res = $context.Response
    $origin = $req.Headers['Origin']
    Set-CorsHeaders -Response $res -AppOrigin $Sync.AppOrigin

    if ($origin -ne $Sync.AppOrigin) {
        Write-JsonResponse -Response $res -StatusCode 403 -Obj @{ error = 'bad-origin' }
        continue
    }

    if ($req.HttpMethod -eq 'OPTIONS') {
        $res.StatusCode = 204
        $res.OutputStream.Close()
        continue
    }

    $session = $req.QueryString['session']
    if ([string]::IsNullOrEmpty($session) -or $session -ne $Sync.Session) {
        Write-JsonResponse -Response $res -StatusCode 403 -Obj @{ error = 'bad-session' }
        continue
    }

    $path = $req.Url.AbsolutePath
    try {
        if ($path -eq '/status' -and $req.HttpMethod -eq 'GET') {
            Write-JsonResponse -Response $res -StatusCode 200 -Obj @{
                version         = $Sync.Version
                port            = $Sync.BridgePort
                phase           = $Sync.Phase
                clientConnected = [bool]$Sync.LcuPort
                lastOpen        = $Sync.LastOpen
                champSelect     = $(if ($Sync.Phase -eq 'ChampSelect') { $Sync.ChampSelectSnapshot } else { $null })
            }
        } elseif ($path -eq '/live' -and $req.HttpMethod -eq 'GET') {
            $live = Get-LiveClientData
            if ($null -eq $live) {
                Write-JsonResponse -Response $res -StatusCode 200 -Obj @{ error = 'no-live' }
            } else {
                Write-JsonResponse -Response $res -StatusCode 200 -Obj $live
            }
        } elseif ($path -eq '/apply-runes' -and $req.HttpMethod -eq 'POST') {
            $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
            $bodyRaw = $reader.ReadToEnd()
            $reader.Close()
            $bodyObj = $null
            try { $bodyObj = $bodyRaw | ConvertFrom-Json } catch {}
            if (-not $Sync.LcuPort) {
                Write-JsonResponse -Response $res -StatusCode 200 -Obj @{ ok = $false; reason = 'no-client' }
            } else {
                $scheme = if ($Sync.LcuScheme) { $Sync.LcuScheme } else { 'https' }
                $result = Invoke-ApplyRunes -Body $bodyObj -LcuPort $Sync.LcuPort -LcuToken $Sync.LcuToken -Scheme $scheme
                Write-JsonResponse -Response $res -StatusCode 200 -Obj $result
                Write-CompanionLog "apply-runes: ok=$($result.ok) reason=$($result.reason)"
            }
        } elseif ($path -eq '/apply-itemsets' -and $req.HttpMethod -eq 'POST') {
            $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
            $bodyRaw = $reader.ReadToEnd()
            $reader.Close()
            $bodyObj = $null
            try { $bodyObj = $bodyRaw | ConvertFrom-Json } catch {}
            if (-not $Sync.LcuPort) {
                Write-JsonResponse -Response $res -StatusCode 200 -Obj @{ ok = $false; reason = 'no-client' }
            } else {
                $scheme = if ($Sync.LcuScheme) { $Sync.LcuScheme } else { 'https' }
                $result = Invoke-ApplyItemSets -Sets $bodyObj.sets -LcuPort $Sync.LcuPort -LcuToken $Sync.LcuToken -Scheme $scheme
                Write-JsonResponse -Response $res -StatusCode 200 -Obj $result
                Write-CompanionLog "apply-itemsets: ok=$($result.ok) reason=$($result.reason) count=$($result.count)"
            }
        } else {
            Write-JsonResponse -Response $res -StatusCode 404 -Obj @{ error = 'not-found' }
        }
    } catch {
        Write-CompanionLog "bridge error: $($_.Exception.Message)"
        try { Write-JsonResponse -Response $res -StatusCode 500 -Obj @{ error = 'internal' } } catch {}
    }
}
'@

function Start-BridgeServer {
    param([string]$AppOrigin, [int[]]$Ports, [string]$Session, [string]$Version)
    $listener = $null
    $port = $null
    foreach ($p in $Ports) {
        try {
            $l = New-Object System.Net.HttpListener
            $l.Prefixes.Add("http://127.0.0.1:$p/")
            $l.Start()
            $listener = $l
            $port = $p
            break
        } catch { continue }
    }
    if (-not $listener) { throw 'No free bridge port available (48291-48293 all in use)' }

    $sync = [hashtable]::Synchronized(@{
        Running             = $true
        Listener            = $listener
        AppOrigin           = $AppOrigin
        Session             = $Session
        Version             = $Version
        BridgePort          = $port
        Phase               = 'None'
        LcuPort             = $null
        LcuToken            = $null
        LcuScheme           = 'https'
        LastOpen            = $null
        ChampSelectSnapshot = $null
    })

    $rs = [runspacefactory]::CreateRunspace()
    $rs.Open()
    $rs.SessionStateProxy.SetVariable('Sync', $sync)
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript($script:SharedFunctionsSrc)
    [void]$ps.AddScript($script:BridgeWorkerSrc)
    $handle = $ps.BeginInvoke()

    return [pscustomobject]@{
        Sync       = $sync
        PowerShell = $ps
        Runspace   = $rs
        Listener   = $listener
        Handle     = $handle
        Port       = $port
    }
}

function Stop-BridgeServer {
    param($Bridge)
    if (-not $Bridge) { return }
    $Bridge.Sync.Running = $false
    try { $Bridge.Listener.Stop() } catch {}
    try { $Bridge.PowerShell.Stop() } catch {}
    try { $Bridge.PowerShell.Dispose() } catch {}
    try { $Bridge.Runspace.Close() } catch {}
}
#endregion

#region Tray
function Start-Companion {
    Initialize-TlsShim
    if (-not (Test-SingleInstance)) {
        Write-Host 'CoachBuild companion already running (mutex held). Exiting.'
        return
    }

    $script:Config.Session = Get-OrCreateSessionToken
    $script:Bridge = Start-BridgeServer -AppOrigin $script:Config.AppOrigin -Ports $script:Config.BridgePorts -Session $script:Config.Session -Version $script:Config.Version
    $script:ChampSelectState = @{ LastOpenedChampId = $null; LastOpenedRoleId = $null }
    $script:WasChampSelect = $false
    $script:LastLoggedPhase = $null

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Application  # never a bare console window (-w hidden at launch)
    $icon.Text = 'CoachBuild Live Companion'
    $icon.Visible = $true

    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $reopenItem = $menu.Items.Add('Reopen page')
    $quitItem = $menu.Items.Add('Quit')

    $reopenItem.add_Click({
        $champId = $script:ChampSelectState.LastOpenedChampId
        $roleId = $script:ChampSelectState.LastOpenedRoleId
        if ($champId) {
            $url = Get-DeepLinkUrl -AppOrigin $script:Config.AppOrigin -SessionToken $script:Config.Session -ChampionId $champId -RoleId $roleId
            Open-CompanionUrl -Url $url
        } else {
            # No champ-select open yet this run -- still carry the session so
            # /live-setup's Test Connection isn't greyed out on first use.
            Open-CompanionUrl -Url "$($script:Config.AppOrigin)/live-setup?session=$($script:Config.Session)"
        }
    })
    $quitItem.add_Click({
        $icon.Visible = $false
        $timer.Stop()
        Stop-BridgeServer -Bridge $script:Bridge
        [System.Windows.Forms.Application]::Exit()
    })
    $icon.ContextMenuStrip = $menu

    Test-AutoUpdate -Icon $icon

    # Gameflow polling rides the tray's own STA message loop as a WinForms
    # Timer tick -- lightweight, non-blocking, and avoids spinning up a
    # second background runspace on top of the bridge server's.
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = $script:Config.PollMs
    $timer.add_Tick({ try { Invoke-GameflowTick } catch {} })
    $timer.Start()

    [System.Windows.Forms.Application]::Run()
}
#endregion

#region AutoUpdate
function Test-AutoUpdate {
    param($Icon)
    try {
        $latest = Invoke-RestMethod -Uri "$($script:Config.AppOrigin)/companion.version" -UseBasicParsing -TimeoutSec 5
        if ($latest -and $latest.version -and $latest.version -ne $script:Config.Version) {
            if ($Icon) {
                $Icon.ShowBalloonTip(5000, 'CoachBuild Companion update available', "Version $($latest.version) is available -- re-run the install command to update.", [System.Windows.Forms.ToolTipIcon]::Info)
            }
        }
    } catch {}
}
#endregion

#region Install
function New-CompanionAutostartVbs {
    # Windows Terminal is the default terminal on Win11 and IGNORES
    # -WindowStyle Hidden on the powershell.exe process it spawns -- a
    # .lnk-based autostart (the original v1.0.0 approach) shows a visible
    # console tab. WScript.Shell.Run's window-style flag (0 = hidden) is
    # honored regardless of the default-terminal setting, so autostart is a
    # silent .vbs launcher instead. Built via string concatenation (not one
    # big escaped literal) so the doubled "" VBS-string-escaping stays
    # readable: part1/part2 are single-quoted PS strings (no escaping needed
    # since they contain only double-quotes), AppOrigin is spliced in the
    # middle.
    param([string]$AppOrigin)
    $part1 = 'CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ""irm '
    $part2 = '/companion.ps1 | iex""", 0, False'
    return $part1 + $AppOrigin + $part2
}

function Install-Companion {
    $startup = [Environment]::GetFolderPath('Startup')
    $lnkPath = Join-Path $startup 'CoachBuildCompanion.lnk'
    $vbsPath = Join-Path $startup 'CoachBuildCompanion.vbs'

    if (Test-Path $lnkPath) {
        Remove-Item $lnkPath -Force
        Write-Host "Removed old startup shortcut: $lnkPath"
    }

    $vbsContent = New-CompanionAutostartVbs -AppOrigin $script:Config.AppOrigin
    Set-Content -Path $vbsPath -Value $vbsContent -Encoding ASCII -NoNewline
    Write-Host "Installed silent startup launcher: $vbsPath"

    # Install -> pair is one flow: open the pairing page immediately with a
    # durable (persisted) session token, so Test Connection works right away
    # instead of waiting for the first champ select.
    $token = Get-OrCreateSessionToken
    try { Start-Process "$($script:Config.AppOrigin)/live-setup?session=$token" | Out-Null } catch {}
}

function Uninstall-Companion {
    $startup = [Environment]::GetFolderPath('Startup')
    $removedAny = $false
    foreach ($name in 'CoachBuildCompanion.lnk', 'CoachBuildCompanion.vbs') {
        $p = Join-Path $startup $name
        if (Test-Path $p) {
            Remove-Item $p -Force
            Write-Host "Removed $p"
            $removedAny = $true
        }
    }
    if (-not $removedAny) { Write-Host 'No startup entry found.' }
}
#endregion

#region SelfTest
$script:MockLcuWorkerSrc = @'
while ($Sync.Running) {
    if (-not $Sync.Listener.IsListening) { Start-Sleep -Milliseconds 100; continue }
    $context = $null
    try {
        $contextTask = $Sync.Listener.GetContextAsync()
        while (-not $contextTask.Wait(200)) {
            if (-not $Sync.Running) { return }
        }
        $context = $contextTask.Result
    } catch {
        continue
    }
    if (-not $context) { continue }

    $req = $context.Request
    $res = $context.Response
    $path = $req.Url.AbsolutePath
    $method = $req.HttpMethod
    [void]$Sync.Calls.Add($method)
    try {
        if ($path -eq '/lol-perks/v1/currentpage' -and $method -eq 'GET') {
            Write-JsonResponse -Response $res -StatusCode 200 -Obj @{ id = 12345; isDeletable = $true }
        } elseif ($path -like '/lol-perks/v1/pages/*' -and $method -eq 'DELETE') {
            if ($Sync.DeleteShouldFail) {
                Write-JsonResponse -Response $res -StatusCode 500 -Obj @{ error = 'mock-delete-failed' }
            } else {
                $res.StatusCode = 204
                $res.OutputStream.Close()
            }
        } elseif ($path -eq '/lol-perks/v1/pages' -and $method -eq 'POST') {
            Write-JsonResponse -Response $res -StatusCode 200 -Obj @{ id = 12346; current = $true }
        } elseif ($path -eq '/lol-summoner/v1/current-summoner' -and $method -eq 'GET') {
            if ($Sync.SummonerGetShouldFail) {
                Write-JsonResponse -Response $res -StatusCode 500 -Obj @{ error = 'mock-summoner-get-failed' }
            } else {
                Write-JsonResponse -Response $res -StatusCode 200 -Obj @{ summonerId = 999 }
            }
        } elseif ($path -like '/lol-item-sets/v1/item-sets/*/sets' -and $method -eq 'GET') {
            if ($Sync.ItemSetsGetShouldFail) {
                Write-JsonResponse -Response $res -StatusCode 500 -Obj @{ error = 'mock-itemsets-get-failed' }
            } else {
                Write-JsonResponse -Response $res -StatusCode 200 -Obj $Sync.ExistingItemSets
            }
        } elseif ($path -like '/lol-item-sets/v1/item-sets/*/sets' -and $method -eq 'PUT') {
            $reader2 = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
            $putBodyRaw = $reader2.ReadToEnd()
            $reader2.Close()
            $Sync.LastPutBody = $putBodyRaw
            $res.StatusCode = 200
            $res.OutputStream.Close()
        } else {
            Write-JsonResponse -Response $res -StatusCode 404 -Obj @{ error = 'mock-not-found' }
        }
    } catch {
        try { Write-JsonResponse -Response $res -StatusCode 500 -Obj @{ error = 'mock-internal' } } catch {}
    }
}
'@

function Start-MockLcu {
    $listener = $null
    $port = $null
    foreach ($p in 49291..49299) {
        try {
            $l = New-Object System.Net.HttpListener
            $l.Prefixes.Add("http://127.0.0.1:$p/")
            $l.Start()
            $listener = $l
            $port = $p
            break
        } catch { continue }
    }
    if (-not $listener) { throw 'No free mock-LCU port available' }

    $sync = [hashtable]::Synchronized(@{
        Running             = $true
        Listener            = $listener
        DeleteShouldFail    = $false
        Calls               = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
        SummonerGetShouldFail = $false
        ItemSetsGetShouldFail = $false
        ExistingItemSets    = [pscustomobject]@{ accountId = 1; timestamp = 0; itemSets = @() }
        LastPutBody         = $null
    })

    $rs = [runspacefactory]::CreateRunspace()
    $rs.Open()
    $rs.SessionStateProxy.SetVariable('Sync', $sync)
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript($script:SharedFunctionsSrc)
    [void]$ps.AddScript($script:MockLcuWorkerSrc)
    $handle = $ps.BeginInvoke()

    return [pscustomobject]@{
        Sync       = $sync
        PowerShell = $ps
        Runspace   = $rs
        Listener   = $listener
        Handle     = $handle
        Port       = $port
    }
}

function Stop-MockLcu {
    param($Mock)
    if (-not $Mock) { return }
    $Mock.Sync.Running = $false
    try { $Mock.Listener.Stop() } catch {}
    try { $Mock.PowerShell.Stop() } catch {}
    try { $Mock.PowerShell.Dispose() } catch {}
    try { $Mock.Runspace.Close() } catch {}
}

function Get-HttpStatusFromException {
    param($ErrorRecord)
    try { if ($ErrorRecord.Exception.Response) { return [int]$ErrorRecord.Exception.Response.StatusCode } } catch {}
    return -1
}

function Invoke-SelfTest {
    Initialize-TlsShim
    $failures = New-Object System.Collections.Generic.List[string]
    $appOrigin = 'https://coachbuild.vercel.app'
    $session = 'test-session-token'

    $mockLcu = Start-MockLcu
    Start-Sleep -Milliseconds 200

    $bridge = Start-BridgeServer -AppOrigin $appOrigin -Ports @(48291, 48292, 48293) -Session $session -Version '1.0.0-selftest'
    $bridge.Sync.LcuPort = $mockLcu.Port
    $bridge.Sync.LcuToken = 'mocktoken'
    $bridge.Sync.LcuScheme = 'http'  # mock LCU is a plain HttpListener, no cert to bind
    $bridge.Sync.Phase = 'InProgress'
    Start-Sleep -Milliseconds 200

    $base = "http://127.0.0.1:$($bridge.Port)"

    # 1. OPTIONS -> 204 + CORS
    try {
        $r = Invoke-WebRequest -Uri "$base/status" -Method OPTIONS -Headers @{ Origin = $appOrigin } -UseBasicParsing
        if ($r.StatusCode -ne 204) { $failures.Add("OPTIONS expected 204, got $($r.StatusCode)") }
        if ($r.Headers['Access-Control-Allow-Origin'] -ne $appOrigin) { $failures.Add('OPTIONS missing/incorrect CORS header') }
    } catch { $failures.Add("OPTIONS request threw: $($_.Exception.Message)") }

    # 2. Wrong origin -> 403
    try {
        $r = Invoke-WebRequest -Uri "$base/status?session=$session" -Method GET -Headers @{ Origin = 'https://evil.example.com' } -UseBasicParsing
        $failures.Add("Wrong-origin request expected 403, got $($r.StatusCode)")
    } catch {
        $code = Get-HttpStatusFromException $_
        if ($code -ne 403) { $failures.Add("Wrong-origin expected 403, got $code") }
    }

    # 3. Missing token -> 403
    try {
        $r = Invoke-WebRequest -Uri "$base/status" -Method GET -Headers @{ Origin = $appOrigin } -UseBasicParsing
        $failures.Add("Missing-token request expected 403, got $($r.StatusCode)")
    } catch {
        $code = Get-HttpStatusFromException $_
        if ($code -ne 403) { $failures.Add("Missing-token expected 403, got $code") }
    }

    # 4. Correct request -> 200 + shape
    try {
        $r = Invoke-WebRequest -Uri "$base/status?session=$session" -Method GET -Headers @{ Origin = $appOrigin } -UseBasicParsing
        if ($r.StatusCode -ne 200) { $failures.Add("Valid /status expected 200, got $($r.StatusCode)") }
        $obj = $r.Content | ConvertFrom-Json
        foreach ($k in 'version', 'port', 'phase', 'clientConnected', 'lastOpen', 'champSelect') {
            if (-not ($obj.PSObject.Properties.Name -contains $k)) { $failures.Add("/status missing field $k") }
        }
        if ($null -ne $obj.lastOpen) { $failures.Add("/status lastOpen expected null before any open, got $($obj.lastOpen)") }
        if ($null -ne $obj.champSelect) { $failures.Add("/status champSelect expected null outside ChampSelect phase, got $($obj.champSelect)") }
    } catch { $failures.Add("/status request threw: $($_.Exception.Message)") }

    # 4b. champSelect snapshot only surfaces while phase==ChampSelect, and
    # reflects whatever Set-ChampSelectSnapshot last wrote (diagnosability).
    $bridge.Sync.Phase = 'ChampSelect'
    $bridge.Sync.ChampSelectSnapshot = @{ localPlayerCellId = 0; cellChampionId = $null; pickIntent = 103; actionChampionId = $null; roleId = 0 }
    try {
        $r = Invoke-WebRequest -Uri "$base/status?session=$session" -Method GET -Headers @{ Origin = $appOrigin } -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.champSelect -or $obj.champSelect.pickIntent -ne 103) {
            $failures.Add("/status champSelect snapshot not echoed correctly: $($r.Content)")
        }
    } catch { $failures.Add("/status champSelect request threw: $($_.Exception.Message)") }
    $bridge.Sync.Phase = 'InProgress'
    $bridge.Sync.ChampSelectSnapshot = $null

    # 5. apply-runes happy path: GET -> DELETE -> POST sequencing
    $mockLcu.Sync.DeleteShouldFail = $false
    $mockLcu.Sync.Calls.Clear()
    $applyBody = @{ name = 'CoachBuild Test'; primaryStyleId = 8000; subStyleId = 8100; selectedPerkIds = @(8005, 9111, 9104, 8014, 8017, 8009, 8017, 5008, 5008); current = $true }
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($applyBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok) { $failures.Add("apply-runes happy path expected ok:true, got $($r.Content)") }
        $calls = @($mockLcu.Sync.Calls)
        if ($calls.Count -lt 3 -or $calls[0] -ne 'GET' -or $calls[1] -ne 'DELETE' -or $calls[2] -ne 'POST') {
            $failures.Add("apply-runes sequencing wrong: $($calls -join ',')")
        }
    } catch { $failures.Add("apply-runes happy path threw: $($_.Exception.Message)") }

    # 6. apply-runes delete-fail envelope (#1013 fail-soft)
    $mockLcu.Sync.DeleteShouldFail = $true
    $mockLcu.Sync.Calls.Clear()
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($applyBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if ($obj.ok -ne $false -or $obj.reason -ne 'delete-failed' -or -not $obj.hint) {
            $failures.Add("apply-runes delete-fail envelope wrong: $($r.Content)")
        }
        if (@($mockLcu.Sync.Calls) -contains 'POST') { $failures.Add('apply-runes POSTed after a failed delete (#1013 fail-soft violated)') }
    } catch { $failures.Add("apply-runes delete-fail threw: $($_.Exception.Message)") }

    # 6b. apply-itemsets happy path: merge preserves a non-CoachBuild set
    # byte-for-byte, and stale CoachBuild sets for the SAME champ+role are
    # replaced, not duplicated.
    $mockLcu.Sync.ExistingItemSets = [pscustomobject]@{
        accountId = 12345
        timestamp = 1700000000
        itemSets  = @(
            [pscustomobject]@{ uid = 'user-1'; title = 'My Custom Build'; type = 'custom'; blocks = @() }
            [pscustomobject]@{ uid = 'coachbuild-viktor-mid-core'; title = "CoachBuild Viktor Mid $([char]0x2014) Core"; type = 'custom'; blocks = @() }
        )
    }
    $newSets = @(
        [pscustomobject]@{ uid = 'coachbuild-viktor-mid-core'; title = "CoachBuild Viktor Mid $([char]0x2014) Core"; type = 'custom'; map = 'any'; mode = 'any'; associatedMaps = @(); associatedChampions = @(112); preferredItemSlots = @(); sortrank = 0; blocks = @(@{ type = 'Starting'; items = @(@{ id = '1054'; count = 1 }) }) }
        [pscustomobject]@{ uid = 'coachbuild-viktor-mid-optimized'; title = "CoachBuild Viktor Mid $([char]0x2014) Optimized"; type = 'custom'; map = 'any'; mode = 'any'; associatedMaps = @(); associatedChampions = @(112); preferredItemSlots = @(); sortrank = 0; blocks = @(@{ type = 'Optimized order'; items = @(@{ id = '3020'; count = 1 }) }) }
    )
    $mockLcu.Sync.LastPutBody = $null
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-itemsets?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes((@{ championId = 112; sets = $newSets } | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok -or $obj.count -ne 2) { $failures.Add("apply-itemsets happy path expected ok:true count:2, got $($r.Content)") }
        if (-not $mockLcu.Sync.LastPutBody) {
            $failures.Add('apply-itemsets happy path never issued a PUT')
        } else {
            $putObj = $mockLcu.Sync.LastPutBody | ConvertFrom-Json
            $putTitles = @($putObj.itemSets | ForEach-Object { $_.title })
            if ($putTitles -notcontains 'My Custom Build') { $failures.Add('apply-itemsets merge dropped a non-CoachBuild set') }
            $coachTitles = @($putTitles | Where-Object { $_ -like 'CoachBuild Viktor Mid*' })
            if ($coachTitles.Count -ne 2) { $failures.Add("apply-itemsets merge should have exactly 2 CoachBuild Viktor Mid sets after replace, got $($coachTitles.Count)") }
            $putCustomEntry = @($putObj.itemSets | Where-Object { $_.title -eq 'My Custom Build' })
            $origCustomEntry = @($mockLcu.Sync.ExistingItemSets.itemSets | Where-Object { $_.title -eq 'My Custom Build' })
            if (($putCustomEntry[0] | ConvertTo-Json -Depth 10 -Compress) -ne ($origCustomEntry[0] | ConvertTo-Json -Depth 10 -Compress)) {
                $failures.Add('apply-itemsets did not preserve the non-CoachBuild set byte-for-byte')
            }
        }
    } catch { $failures.Add("apply-itemsets happy path threw: $($_.Exception.Message)") }

    # 6c. apply-itemsets GET-fail -> read-failed envelope, and NEVER a PUT.
    $mockLcu.Sync.ItemSetsGetShouldFail = $true
    $mockLcu.Sync.LastPutBody = $null
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-itemsets?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes((@{ championId = 112; sets = $newSets } | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if ($obj.ok -ne $false -or $obj.reason -ne 'read-failed') { $failures.Add("apply-itemsets GET-fail expected read-failed envelope, got $($r.Content)") }
        if ($mockLcu.Sync.LastPutBody) { $failures.Add('apply-itemsets issued a PUT despite a failed GET') }
    } catch { $failures.Add("apply-itemsets GET-fail threw: $($_.Exception.Message)") }
    $mockLcu.Sync.ItemSetsGetShouldFail = $false

    # 6d. apply-itemsets rejects a malicious/non-CoachBuild title outright --
    # never writes it, no matter what.
    $maliciousSets = @(
        [pscustomobject]@{ uid = 'x'; title = 'MyRealSet'; type = 'custom'; map = 'any'; mode = 'any'; associatedMaps = @(); associatedChampions = @(112); preferredItemSlots = @(); sortrank = 0; blocks = @() }
    )
    $mockLcu.Sync.LastPutBody = $null
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-itemsets?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes((@{ championId = 112; sets = $maliciousSets } | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if ($obj.ok -ne $false -or $obj.reason -ne 'invalid-sets') { $failures.Add("apply-itemsets malicious title expected invalid-sets rejection, got $($r.Content)") }
        if ($mockLcu.Sync.LastPutBody) { $failures.Add('apply-itemsets issued a PUT for a non-CoachBuild-titled set') }
    } catch { $failures.Add("apply-itemsets malicious title threw: $($_.Exception.Message)") }

    Stop-BridgeServer -Bridge $bridge
    Stop-MockLcu -Mock $mockLcu

    # 7. Session token persistence round-trip -- isolated temp dir, never
    # touches the real %LOCALAPPDATA%\CoachBuild. Cleaned up regardless of
    # outcome so SelfTest never litters the machine it runs on.
    $tmpSessionDir = Join-Path $env:TEMP ("coachbuild-selftest-" + [guid]::NewGuid().ToString('N'))
    try {
        $tok1 = Get-OrCreateSessionToken -BaseDir $tmpSessionDir
        $tok2 = Get-OrCreateSessionToken -BaseDir $tmpSessionDir
        if ([string]::IsNullOrEmpty($tok1)) { $failures.Add('Get-OrCreateSessionToken returned empty on first call') }
        if ($tok1 -ne $tok2) { $failures.Add("Session token not stable across calls: '$tok1' vs '$tok2'") }
        $sessionFilePath = Join-Path $tmpSessionDir 'companion-session.txt'
        if (-not (Test-Path $sessionFilePath)) { $failures.Add("Session token file not created at $sessionFilePath") }
    } catch {
        $failures.Add("Session token persistence threw: $($_.Exception.Message)")
    } finally {
        try { Remove-Item $tmpSessionDir -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    }

    # 8. Autostart VBS content is well-formed (window-style flag 0 = hidden,
    # correct AppOrigin spliced in, valid VBS string-escaping).
    $vbs = New-CompanionAutostartVbs -AppOrigin 'https://coachbuild.vercel.app'
    if ($vbs -notmatch '^CreateObject\("WScript\.Shell"\)\.Run "powershell\.exe .*", 0, False$') {
        $failures.Add("Autostart VBS content malformed: $vbs")
    }
    if ($vbs -notlike '*irm https://coachbuild.vercel.app/companion.ps1 | iex*') {
        $failures.Add("Autostart VBS missing expected install command: $vbs")
    }

    if ($failures.Count -gt 0) {
        Write-Host "SELFTEST FAILED ($($failures.Count)):" -ForegroundColor Red
        $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
        exit 1
    } else {
        Write-Host 'SELFTEST PASSED' -ForegroundColor Green
        exit 0
    }
}
#endregion

#region Mock
function Invoke-MockRun {
    param([switch]$Once)
    # Deterministic scripted phase sequence (Lobby is a no-op, so it's
    # implicit -- nothing opens until ChampSelect): hover Ahri (103, top) ->
    # re-poll same hover (simulates a teammate action re-triggering our
    # session poll) -> lock Ahri (championId now set, still 103) -> swap to
    # LeBlanc (7). Asserts: exactly 2 opens (initial hover, then the swap),
    # with the debounce collapsing the same-champ hover/lock/re-poll steps
    # into a single open, and the deep-link URL format is exact.
    $script:MockMode = $true
    $script:OpenActions = New-Object System.Collections.Generic.List[string]
    $appOrigin = 'https://coachbuild.vercel.app'
    $sessionToken = 'mock-session-token'
    $state = @{ LastOpenedChampId = $null }
    $failures = New-Object System.Collections.Generic.List[string]

    function New-MockChampSelectSession {
        param([int]$ChampId, [int]$IntentId, [string]$Position, $Actions = @())
        return [pscustomobject]@{
            localPlayerCellId = 0
            myTeam            = @([pscustomobject]@{ cellId = 0; championId = $ChampId; championPickIntent = $IntentId; assignedPosition = $Position })
            actions           = $Actions
        }
    }

    Reset-ChampSelectState -State $state
    Update-ChampSelectState -State $state -Session (New-MockChampSelectSession -ChampId 0 -IntentId 103 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    Update-ChampSelectState -State $state -Session (New-MockChampSelectSession -ChampId 0 -IntentId 103 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    Update-ChampSelectState -State $state -Session (New-MockChampSelectSession -ChampId 103 -IntentId 103 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    Update-ChampSelectState -State $state -Session (New-MockChampSelectSession -ChampId 7 -IntentId 7 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken

    if ($script:OpenActions.Count -ne 2) {
        $failures.Add("Expected exactly 2 opens (initial hover + champ swap), got $($script:OpenActions.Count): $($script:OpenActions -join ' | ')")
    } else {
        $expected1 = "$appOrigin/?championId=103&role=0&session=$sessionToken"
        $expected2 = "$appOrigin/?championId=7&role=0&session=$sessionToken"
        if ($script:OpenActions[0] -ne $expected1) { $failures.Add("Open #1 mismatch: got $($script:OpenActions[0]) want $expected1") }
        if ($script:OpenActions[1] -ne $expected2) { $failures.Add("Open #2 mismatch: got $($script:OpenActions[1]) want $expected2") }
    }

    # Role-LESS check (v1.2.0 fix -- was a live-reported bug: v1.1.0 silently
    # skipped opening ENTIRELY for a blank/unmapped assignedPosition, i.e.
    # every custom lobby, blind pick, and ARAM game). Must still open, just
    # WITHOUT a role param.
    $script:OpenActions.Clear()
    $roleLessState = @{ LastOpenedChampId = $null }
    Update-ChampSelectState -State $roleLessState -Session (New-MockChampSelectSession -ChampId 99 -IntentId 99 -Position '') -AppOrigin $appOrigin -SessionToken $sessionToken
    $expectedRoleLess = "$appOrigin/?championId=99&session=$sessionToken"
    if ($script:OpenActions.Count -ne 1 -or $script:OpenActions[0] -ne $expectedRoleLess) {
        $failures.Add("Role-less open expected exactly 1 open to '$expectedRoleLess', got $($script:OpenActions.Count): $($script:OpenActions -join ' | ')")
    }
    # Debounce still applies to a role-less champion -- re-polling the SAME
    # blank-position hover must not reopen.
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $roleLessState -Session (New-MockChampSelectSession -ChampId 99 -IntentId 99 -Position '') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 0) {
        $failures.Add("Role-less debounce failed -- re-polling the same champion reopened ($($script:OpenActions.Count) opens)")
    }

    # actions[]-only champion resolution (live-reported bug, draft-style bot
    # lobby WITH real assignedPositions): a pre-lock hover with BOTH cell
    # championId and championPickIntent still 0 must still resolve -- and
    # open -- via session.actions (array OF ARRAYS; the comma-prefix below
    # is the standard PS idiom preventing a single-element array from being
    # silently unwrapped/flattened).
    $script:OpenActions.Clear()
    $actionsOnlyState = @{ LastOpenedChampId = $null }
    $actionRow = @([pscustomobject]@{ actorCellId = 0; type = 'pick'; championId = 64; completed = $false })
    $actionsSession = New-MockChampSelectSession -ChampId 0 -IntentId 0 -Position 'jungle' -Actions (, $actionRow)
    Update-ChampSelectState -State $actionsOnlyState -Session $actionsSession -AppOrigin $appOrigin -SessionToken $sessionToken
    $expectedActionsOnly = "$appOrigin/?championId=64&role=1&session=$sessionToken"
    if ($script:OpenActions.Count -ne 1 -or $script:OpenActions[0] -ne $expectedActionsOnly) {
        $failures.Add("actions[]-only resolution expected exactly 1 open to '$expectedActionsOnly', got $($script:OpenActions.Count): $($script:OpenActions -join ' | ')")
    }

    if ($failures.Count -gt 0) {
        Write-Host "MOCK RUN FAILED ($($failures.Count)):" -ForegroundColor Red
        $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
        exit 1
    } else {
        Write-Host 'MOCK RUN PASSED' -ForegroundColor Green
        exit 0
    }
}
#endregion

#region Dispatch
Initialize-TlsShim

if ($SelfTest) {
    Invoke-SelfTest
} elseif ($Mock) {
    Invoke-MockRun -Once:$Once
} elseif ($Install) {
    Install-Companion
} elseif ($Uninstall) {
    Uninstall-Companion
} else {
    Start-Companion
}
#endregion
