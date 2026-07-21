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
  - v1.3.0 COMPLIANCE UPDATE (deliberate, documented -- supersedes the prior
    "runes strictly user-clicked" line): rune WRITES may now fire
    automatically on a champ-select deep-link too (same class as a
    Blitz/Moba auto-import -- an inert loadout write, not a game action;
    the player never acted on their behalf, the client just now shows a
    different rune page the player still has to accept/play with). Both
    rune apply (POST /apply-runes, mode:'auto'|'manual') and item-set
    writes (POST /apply-itemsets) MAY auto-export on a champ-select deep-
    link (opt-out toggles, /live-setup, both default ON once paired). The
    one bright line that does NOT move: auto mode must NEVER delete a rune
    page it doesn't own -- it only ever replaces a page it PREVIOUSLY
    created (title starts with "CoachBuild") or uses a genuinely free slot;
    if neither is available it returns {reason:'slots-full'} and touches
    NOTHING, full stop (SelfTest-pinned: an adversarial 5-page, 0-CoachBuild
    fixture in auto mode must never issue a single DELETE call). Manual
    mode (the user-clicked button) keeps the original consented behavior --
    it may still replace whatever page is currently selected, exactly as
    before, since a real click is real consent.
  - Item-SET writes (POST /apply-itemsets) are inert shop-panel suggestions
    (same class as Blitz/u.gg's auto-import; compliance-fine, not gameplay
    automation). The distinction that makes BOTH rune-auto-export and
    item-set-auto-export fine while game-action-automation never is: a
    rune page or item set is a passive loadout/shopping suggestion the
    player still has to accept and play with; it does not act in the game
    on the player's behalf the way an auto-pick/auto-lock/auto-accept would.
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
                                  actionChampionId|null, roleId|null,
                                  theirTeam:number[], timerPhase:string|null}
                                  |null (null outside phase=="ChampSelect")
                                  -- v1.4.0 (Draft recommender, plan section 5):
                                  theirTeam is the enemy team's championId
                                  per slot (>0 only; a hovering-but-unlocked
                                  enemy is represented by their
                                  championPickIntent in that slot instead --
                                  visible info, IDs only, never names, same
                                  posture as every other champSelect field
                                  here); timerPhase is session.timer.phase
                                  straight off the LCU, null if the session
                                  has no timer object,
                                lastPollAt:string|null (ISO, updated every
                                  poll tick regardless of LCU presence),
                                lastError:string|null (most recent
                                  unexpected-failure message, throttled to
                                  ~1 per 60s per distinct failure -- never
                                  contains the session token or a name)}
  - GET  /live         -> 200 <raw allgamedata JSON> | 200 {error:"no-live"}
  - POST /apply-runes  body {name, primaryStyleId, subStyleId,
                              selectedPerkIds:number[9], current:true,
                              mode:'auto'|'manual' (optional, validated,
                                defaults to 'manual' for back-compat with
                                pre-1.3.0 web builds)}
                       -> 200 {ok:true, selected:boolean, verified:boolean,
                                mismatch:string[]}
                        | 200 {ok:false, reason:string, hint?:string}
    Page-selection logic (BOTH modes): GET /lol-perks/v1/pages (only
    isDeletable:true pages count -- preset/default pages never do). A page
    titled starting "CoachBuild" already exists -> DELETE the oldest such
    page -> POST (replaces OUR OWN prior page, either mode). None exists ->
    is there a free slot (GET /lol-perks/v1/inventory ownedPageCount vs the
    editable-page count when available; else a speculative POST, since the
    LCU itself rejects a full inventory) -> POST directly, no delete at
    all. Genuinely full AND no CoachBuild page to replace: mode='manual'
    (a real user click = real consent) falls back to the ORIGINAL behavior
    -- GET currentpage -> DELETE it -> POST; mode='auto' NEVER deletes a
    page it doesn't own -> {ok:false, reason:'slots-full', hint:'all rune
    pages are yours -- click Apply runes to replace the current one'}.
    Post-create SELECTION (v1.3.0 blocker fix, live-reported: a created page
    saved correctly but the client stayed on a fresh "ADD NEW PAGE" editor --
    `current:true` in the POST body alone does NOT select it): after every
    successful create, PUT the raw page id to /lol-perks/v1/currentpage,
    then GET /lol-perks/v1/currentpage back and compare id/name/
    selectedPerkIds to what was sent -- `selected` reflects whether the PUT
    succeeded, `verified`/`mismatch` reflect whether the readback matches
    byte-for-byte (a failed selection or a content mismatch still reports
    ok:true -- the page WAS created -- so the web toast can say "saved --
    pick it in the client" rather than falsely implying full success).
  - POST /apply-itemsets body {championId:int, sets:ItemSet[] (1-3, each
                                title MUST start with "CoachBuild" -- the
                                bridge validates this defensively and
                                rejects otherwise, never writing a
                                non-CoachBuild-titled set),
                                replacePrefix?:string (v1.3.1 -- if present,
                                MUST also start with "CoachBuild" or the
                                whole request is rejected the same way)}
                       -> 200 {ok:true, count:number}
                        | 200 {ok:false, reason:string, hint?:string}
    Merge semantics (PUT to /lol-item-sets/v1/item-sets/{id}/sets REPLACES
    THE ENTIRE object -- the #1 correctness risk): GET the full existing
    sets object first; NEVER PUT on a failed GET (-> {ok:false,
    reason:'read-failed'}); keep every existing set whose title does NOT
    start with the stale-removal prefix (so a CoachBuild set for a
    DIFFERENT champion accumulates across sessions rather than being
    wiped); replace (not duplicate) stale sets matching that prefix; PUT
    back every other top-level field (accountId, timestamp, etc.)
    byte-for-byte untouched.
    v1.3.1 stale-removal prefix (live bug: a LANE FLIP, e.g. Senna Bot ->
    Support, left BOTH "CoachBuild Senna Bot" and "CoachBuild Senna
    Support" behind -- the OLD prefix derivation was role-scoped, derived
    from the new set's own title): prefer the explicit `replacePrefix` the
    web side now sends (CHAMP-SCOPED, e.g. "CoachBuild Senna " -- trailing
    space load-bearing, see itemSetBody.ts's champScopedReplacePrefix) when
    present; fall back to the ORIGINAL title-derived (role-scoped, em-dash-
    stripped) prefix when absent, for back-compat with an older web build
    or an older companion that predates this field.
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
    champ-select uses 1s session polling instead (see decisions, plan section 7).
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
    [int]$TimeoutSec = 15,
    # v1.2.1 -- runs the FULL real-mode harness (tray suppressed) for N
    # seconds then exits 0. This is what -HarnessTest launches as a child
    # process to prove the real gameflow-poll loop actually ticks -- the
    # blind spot that shipped a dead-loop regression undetected (-Mock
    # drives the champ-select logic directly; -SelfTest only exercises the
    # bridge; neither ever ran Start-Companion's real loop until now).
    [int]$DebugRunSeconds = 0,
    [switch]$HarnessTest
)

#region Config
$script:Config = @{
    Version     = '1.4.1'
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
    #
    # v1.2.2 FIX (live-reported: real champ select stuck at Phase:None with
    # Client:Connected, even after the v1.2.1 loop-harness rewrite): a
    # PowerShell SCRIPTBLOCK is runspace-affine -- it can only execute on a
    # thread that has a PowerShell runspace attached. .NET invokes
    # ServerCertificateValidationCallback during the TLS handshake on a
    # THREADPOOL thread that has NO runspace, so a scriptblock callback
    # ({ $true }) throws there. On this dev box that's invisible (no League
    # client -> no HTTPS call to the LCU is EVER attempted, so the handshake
    # callback is never invoked at all -- that's exactly why everything read
    # green here through v1.2.1). On a machine with a real client, EVERY
    # HTTPS call to the self-signed LCU dies at the handshake ->
    # Invoke-LcuRaw returns Ok=$false -> phase never leaves 'None' -- while
    # clientConnected stays true because that flag only reflects the
    # CIM/lockfile credential lookup, never an actual successful LCU call.
    # Fix: a COMPILED .NET delegate (via Add-Type), not a scriptblock --
    # compiled code has no runspace affinity and runs correctly on any
    # thread, including the handshake's threadpool thread.
    if (-not ([System.Management.Automation.PSTypeName]'CoachBuildCertPolicy').Type) {
        Add-Type -TypeDefinition @"
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
public static class CoachBuildCertPolicy {
    public static bool AlwaysTrue(object s, X509Certificate c, X509Chain ch, SslPolicyErrors e) { return true; }
    public static void Apply() { ServicePointManager.ServerCertificateValidationCallback = AlwaysTrue; }
}
"@
    }
    [CoachBuildCertPolicy]::Apply()
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

function Get-CompanionSyncRef {
    # Resolves the ONE shared state hashtable regardless of which context
    # this runs in: the bridge/mock-LCU runspace has a bare $Sync variable
    # (set via SessionStateProxy.SetVariable before this source is injected
    # via AddScript); the main thread instead has $script:Bridge.Sync.
    # Returns $null if neither exists (e.g. -Mock, which never starts a
    # real bridge) -- every caller treats that as "nowhere to record this."
    $bare = Get-Variable -Name Sync -ErrorAction SilentlyContinue
    if ($bare -and $bare.Value) { return $bare.Value }
    if ($script:Bridge -and $script:Bridge.Sync) { return $script:Bridge.Sync }
    return $null
}

function Write-ThrottledErrorLog {
    # v1.2.2 (live-reported: 3 companion.log tails showed only the startup
    # phase-transition line, nothing else, while sitting in a real champ
    # select with the client connected -- the ACTUAL failing call's
    # exception was being swallowed inside Invoke-LcuRaw's own try/catch,
    # one layer below where v1.2.1's logging was added). This is the
    # generic, THROTTLED logger every real-LCU-call catch block routes
    # through: the same failure can hit every single poll tick (1.5s) --
    # without throttling, a persistently-failing call floods the 200KB
    # rolling log within minutes and evicts everything else. Logs (and
    # updates /status's lastError) at most once per ~60s per distinct Key.
    param([string]$Key, [string]$Message)
    $sync = Get-CompanionSyncRef
    $now = Get-Date
    if ($sync -and $sync.LastErrorKey -eq $Key -and $sync.LastErrorAt) {
        try {
            if (((New-TimeSpan -Start ([datetime]$sync.LastErrorAt) -End $now).TotalSeconds) -lt 60) { return }
        } catch {}
    }
    Write-CompanionLog $Message -IsError
    if ($sync) {
        $sync.LastErrorKey = $Key
        $sync.LastErrorAt = $now
    }
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
        # -InputObject, not piped: piping an empty ARRAY into ConvertTo-Json
        # unrolls it to zero pipeline objects and produces no output at all
        # (see Write-JsonResponse's identical fix) -- defensive here too,
        # even though $Body is a hashtable/object/scalar in every call site
        # today, never a bare empty array.
        $json = ConvertTo-Json -InputObject $Body -Depth 10 -Compress
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
        # v1.2.2: this used to swallow the exception with ZERO trace -- the
        # exact gap that let a real "every LCU call dies" failure ship
        # invisibly (companion.log showed nothing past startup even while
        # sitting in a live champ select). Throttled (see
        # Write-ThrottledErrorLog) so a persistent failure logs once per
        # ~60s, not once per 1.5s poll.
        Write-ThrottledErrorLog -Key "lcu:$Method $Path" -Message "Invoke-LcuRaw failed: $Method $Path -- $($_.Exception.GetType().Name): $($_.Exception.Message)"
        return [pscustomobject]@{ Ok = $false; StatusCode = $status; Content = $null }
    }
}

function Get-LiveClientData {
    try {
        return Invoke-RestMethod -Uri 'https://127.0.0.1:2999/liveclientdata/allgamedata' -UseBasicParsing -TimeoutSec 3
    } catch {
        Write-ThrottledErrorLog -Key 'live-client-data' -Message "Get-LiveClientData failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
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
    # v1.3.0 bug (found via SelfTest on an empty rune-pages fixture): PIPING
    # an object into ConvertTo-Json (`$Obj | ConvertTo-Json`) unrolls an
    # ARRAY into the pipeline one element at a time -- for a genuinely EMPTY
    # array that means ConvertTo-Json receives ZERO pipeline objects and
    # produces NO output at all (not the JSON literal "[]"), leaving $json
    # as $null; GetBytes($null) below then throws, and every caller's own
    # try/catch turns that into an opaque 500. -InputObject treats the
    # array as ONE value instead of unrolling it, so an empty array
    # correctly serializes to "[]" -- this is the fix for @{} routes ever
    # writing an empty collection (e.g. /lol-perks/v1/pages with zero
    # custom pages).
    param($Response, [int]$StatusCode, $Obj)
    $json = ConvertTo-Json -InputObject $Obj -Depth 10 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $Response.StatusCode = $StatusCode
    $Response.ContentType = 'application/json'
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Complete-RuneApply {
    # v1.3.0 BLOCKER FIX (live-reported, 2nd screenshot): the created page
    # DID save correctly (creation was never the bug) -- the client just
    # stayed on a fresh "ADD NEW PAGE" editor instead of switching to it.
    # `current:true` in the POST body is evidently NOT sufficient to select
    # a page in the live client. Fix: PUT the raw page id to
    # /lol-perks/v1/currentpage right after a successful create -- the
    # documented post-create selection call (the old "never PUT currentpage
    # to an uncreated page" warning is about PUTting BEFORE creation, not
    # after). Fail-soft: a failed selection PUT still reports ok:true (the
    # page WAS created) but selected:false, so the web toast can say "saved
    # -- pick it in the client" instead of falsely implying it's active.
    #
    # Verify-by-readback: GET currentpage back and compare id/name/
    # selectedPerkIds to what we sent -- catches a silent partial apply
    # (some slots didn't stick) instead of trusting a 2xx blindly.
    param($PostResult, $Body, [int]$LcuPort, [string]$LcuToken, [string]$Scheme)
    $pageId = $PostResult.Content.id
    $selected = $false
    if ($pageId) {
        $selectPut = Invoke-LcuRaw -Method PUT -Path '/lol-perks/v1/currentpage' -Body $pageId -Port $LcuPort -Token $LcuToken -Scheme $Scheme
        $selected = [bool]$selectPut.Ok
    }

    $verified = $false
    $mismatch = @()
    $current = Invoke-LcuRaw -Method GET -Path '/lol-perks/v1/currentpage' -Port $LcuPort -Token $LcuToken -Scheme $Scheme
    if ($current.Ok -and $current.Content -and $pageId -and ([string]$current.Content.id -eq [string]$pageId)) {
        if ($current.Content.name -ne $Body.name) { $mismatch += 'name' }
        $gotPerks = @($current.Content.selectedPerkIds)
        $wantPerks = @($Body.selectedPerkIds)
        if ($gotPerks.Count -ne $wantPerks.Count) {
            $mismatch += 'selectedPerkIds'
        } else {
            for ($i = 0; $i -lt $wantPerks.Count; $i++) {
                if ([int]$gotPerks[$i] -ne [int]$wantPerks[$i]) { $mismatch += "selectedPerkIds[$i]"; break }
            }
        }
        $verified = $mismatch.Count -eq 0
    }

    return [pscustomobject]@{ ok = $true; selected = $selected; verified = $verified; mismatch = $mismatch }
}

function Invoke-ApplyRunes {
    # v1.3.0 SAFETY REDESIGN: the original importer pattern (GET currentpage
    # -> DELETE it -> POST) deletes WHATEVER page happens to be selected --
    # fine under a real user click (real consent), unacceptable to ever
    # auto-fire (could silently wipe a page that isn't ours at all). New
    # page-selection logic, same for BOTH modes: prefer replacing a page WE
    # created (title starts with "CoachBuild"); else use a genuinely free
    # slot; only fall back to "delete whatever's selected" in manual mode,
    # where a real click IS real consent. Auto mode NEVER deletes a
    # non-CoachBuild page -- SelfTest-pinned (adversarial 5-page,
    # 0-CoachBuild fixture must produce zero DELETE calls).
    # Bug #1013 (RiotGames/developer-relations): DELETE on an isDeletable
    # page can falsely fail -- fail SOFT everywhere (never attempt a POST
    # after a failed delete) and surface a manual-delete hint instead of
    # retrying or forcing anything.
    param($Body, [int]$LcuPort, [string]$LcuToken, [string]$Scheme = 'https', [string]$Mode = 'manual')

    $pagesResult = Invoke-LcuRaw -Method GET -Path '/lol-perks/v1/pages' -Port $LcuPort -Token $LcuToken -Scheme $Scheme
    if (-not $pagesResult.Ok) {
        # NOTE: only $pagesResult.Ok gates this -- a genuinely EMPTY pages
        # array is a legitimate, successful response (no custom pages yet),
        # not a failure. PS 5.1's ConvertFrom-Json famously returns $null
        # (not @()) for the JSON literal "[]", so `$null -eq Content` is NOT
        # a reliable failure signal here; @() below normalizes either shape
        # to zero usable pages.
        return [pscustomobject]@{ ok = $false; reason = 'read-failed'; hint = 'could not read existing rune pages -- nothing was changed' }
    }
    # Only DELETABLE (custom) pages count toward slot usage or are eligible
    # CoachBuild-page targets -- preset/default pages that ship with the
    # client can't be removed and were never ours to begin with.
    $editablePages = @(@($pagesResult.Content) | Where-Object { $_.isDeletable -eq $true })
    $coachPages = @($editablePages | Where-Object { $_.name -and ([string]$_.name).StartsWith('CoachBuild') })

    if ($coachPages.Count -gt 0) {
        # A CoachBuild page already exists -- replace THAT one (oldest by
        # id if several), never anyone else's page, in EITHER mode.
        $target = ($coachPages | Sort-Object -Property id)[0]
        $del = Invoke-LcuRaw -Method DELETE -Path "/lol-perks/v1/pages/$($target.id)" -Port $LcuPort -Token $LcuToken -Scheme $Scheme
        if (-not $del.Ok) {
            return [pscustomobject]@{ ok = $false; reason = 'delete-failed'; hint = 'delete a rune page manually and retry' }
        }
        $post = Invoke-LcuRaw -Method POST -Path '/lol-perks/v1/pages' -Body $Body -Port $LcuPort -Token $LcuToken -Scheme $Scheme
        if (-not $post.Ok) { return [pscustomobject]@{ ok = $false; reason = 'create-failed' } }
        return Complete-RuneApply -PostResult $post -Body $Body -LcuPort $LcuPort -LcuToken $LcuToken -Scheme $Scheme
    }

    # No CoachBuild page yet -- is there a free slot? Prefer the
    # inventory-reported cap when available (avoids a doomed POST attempt);
    # fall back to a speculative POST when the endpoint's unavailable/
    # unreadable (the LCU itself authoritatively rejects a full inventory).
    $hasFreeSlot = $null
    $inv = Invoke-LcuRaw -Method GET -Path '/lol-perks/v1/inventory' -Port $LcuPort -Token $LcuToken -Scheme $Scheme
    if ($inv.Ok -and $inv.Content -and $inv.Content.ownedPageCount) {
        $hasFreeSlot = $editablePages.Count -lt [int]$inv.Content.ownedPageCount
    }

    if ($hasFreeSlot -ne $false) {
        $post = Invoke-LcuRaw -Method POST -Path '/lol-perks/v1/pages' -Body $Body -Port $LcuPort -Token $LcuToken -Scheme $Scheme
        if ($post.Ok) { return Complete-RuneApply -PostResult $post -Body $Body -LcuPort $LcuPort -LcuToken $LcuToken -Scheme $Scheme }
        # POST failed -- the LCU's own rejection is authoritative regardless
        # of what the inventory guess said; fall through to the full path.
    }

    if ($Mode -ne 'auto') {
        # Manual mode, user consented via a real click: original behavior --
        # delete whatever's currently selected, then POST.
        $current = Invoke-LcuRaw -Method GET -Path '/lol-perks/v1/currentpage' -Port $LcuPort -Token $LcuToken -Scheme $Scheme
        if ($current.Ok -and $current.Content -and $current.Content.id) {
            $del = Invoke-LcuRaw -Method DELETE -Path "/lol-perks/v1/pages/$($current.Content.id)" -Port $LcuPort -Token $LcuToken -Scheme $Scheme
            if (-not $del.Ok) {
                return [pscustomobject]@{ ok = $false; reason = 'delete-failed'; hint = 'delete a rune page manually and retry' }
            }
        }
        $post2 = Invoke-LcuRaw -Method POST -Path '/lol-perks/v1/pages' -Body $Body -Port $LcuPort -Token $LcuToken -Scheme $Scheme
        if (-not $post2.Ok) { return [pscustomobject]@{ ok = $false; reason = 'create-failed' } }
        return Complete-RuneApply -PostResult $post2 -Body $Body -LcuPort $LcuPort -LcuToken $LcuToken -Scheme $Scheme
    }

    # Auto mode, genuinely full, nothing of ours to replace: touch NOTHING.
    return [pscustomobject]@{ ok = $false; reason = 'slots-full'; hint = 'all rune pages are yours -- click Apply runes to replace the current one' }
}

function Write-CompanionLog {
    # Rolling diagnostic log -- see header comment's LOGGING section. Shared
    # so both the main thread (phase transitions, champ-select opens) and
    # the bridge runspace (apply-runes/apply-itemsets results, errors) write
    # through the same implementation. Never logs the session token or any
    # name -- callers pass already-safe messages only.
    #
    # -IsError also mirrors $Message into /status's `lastError` field (via
    # Get-CompanionSyncRef) -- one screenshot of /live-setup should be
    # enough to see the real failure next time, not just "something is
    # wrong." Routine informational lines (phase transitions, champ-select
    # opens, apply-* results) do NOT set this -- only genuine unexpected
    # failures (Write-ThrottledErrorLog's callers) do.
    param([string]$Message, [switch]$IsError)
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

    if ($IsError) {
        try {
            $sync = Get-CompanionSyncRef
            if ($sync) { $sync.LastError = $Message }
        } catch {}
    }
}

function Test-ItemSetsPayload {
    # Defense-in-depth (SelfTest-pinned): every incoming set's title MUST
    # start with "CoachBuild" -- the bridge refuses to write anything else,
    # so a compromised/buggy web client can never smuggle an arbitrarily
    # titled set into the user's client via this endpoint. 1-3 sets only
    # ("top 3 if available" -- the web side never sends more, but the bridge
    # doesn't trust that on its own either).
    # v1.3.1: `ReplacePrefix`, when present, is validated the SAME way (must
    # start with "CoachBuild") -- an explicit stale-removal prefix is just as
    # capable of touching arbitrary existing sets as a title is, so it gets
    # the identical defense-in-depth treatment. $null (the field was simply
    # omitted -- an older web build) always passes this check; only a
    # genuinely present-but-wrong-prefixed value is rejected.
    param($Sets, $ReplacePrefix = $null)
    $arr = @($Sets)
    if ($arr.Count -lt 1 -or $arr.Count -gt 3) { return $false }
    foreach ($s in $arr) {
        if (-not $s -or -not $s.title) { return $false }
        if (-not ([string]$s.title).StartsWith('CoachBuild')) { return $false }
    }
    if ($ReplacePrefix -and -not ([string]$ReplacePrefix).StartsWith('CoachBuild')) { return $false }
    return $true
}

function Merge-ItemSets {
    # PUT REPLACES THE ENTIRE item-sets object -- the #1 correctness risk
    # (plan finding). Never blind-PUT: every other top-level field on the
    # GET'd object (accountId, timestamp, whatever else the client emits)
    # passes through UNTOUCHED; only .itemSets is rebuilt. Keeps every
    # existing set whose title does NOT start with the stale-removal prefix
    # -- a CoachBuild set for a DIFFERENT champion accumulates across
    # sessions instead of being wiped by an unrelated update; only stale
    # matches are replaced, not duplicated.
    #
    # v1.3.1 stale-removal prefix (live bug fix -- see this file's header
    # WIRE CONTRACT note): prefers the caller's explicit, CHAMP-SCOPED
    # `ReplacePrefix` (e.g. "CoachBuild Senna " -- trailing space
    # load-bearing) when supplied -- a LANE FLIP (Senna Bot -> Support) then
    # correctly removes the OLD lane's stale set instead of leaving it
    # alongside the new one, since both titles share this wider, champ-only
    # prefix. Falls back to the ORIGINAL role-scoped, em-dash-derived prefix
    # (from the new set's own title) when omitted -- back-compat with an
    # older web build that never sends this field.
    param($ExistingSetsObject, $NewSets, $ReplacePrefix = $null)
    $newArr = @($NewSets)
    $prefix = $null
    if ($ReplacePrefix) {
        $prefix = [string]$ReplacePrefix
    } else {
        # NOTE: matches the U+2014 EM DASH via a \uXXXX regex escape, NEVER a
        # literal non-ASCII byte in this file's own source -- this script has
        # no reliable BOM/encoding guarantee served over irm|iex (a literal
        # non-ASCII char here previously broke this file's OWN tokenizer
        # under a misdetected codepage). The title strings THEMSELVES (JSON
        # sent from the web side at runtime, e.g. "CoachBuild Viktor Mid
        # <U+2014> Core") still carry a real em dash -- this escape matches
        # it fine. Pre-1.3.1 web builds ship a NO-suffix title
        # ("CoachBuild <champ> <role>", no em dash at all) -- the regex
        # simply doesn't match anything in that case, so $prefix ends up
        # being the full, role-scoped title unchanged, exactly the old
        # per-champ+role (not per-champ) behavior this fallback preserves.
        $prefix = ([string]$newArr[0].title) -replace ('\s+' + [char]0x2014 + '.*$'), ''
    }
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
    param($Sets, [int]$LcuPort, [string]$LcuToken, [string]$Scheme = 'https', $ReplacePrefix = $null)
    if (-not (Test-ItemSetsPayload -Sets $Sets -ReplacePrefix $ReplacePrefix)) {
        return [pscustomobject]@{ ok = $false; reason = 'invalid-sets'; hint = 'each set title (and replacePrefix, if given) must start with "CoachBuild" (1-3 sets)' }
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
    $merged = Merge-ItemSets -ExistingSetsObject $existing.Content -NewSets $Sets -ReplacePrefix $ReplacePrefix
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
        # v1.2.1: this used to swallow the exception with no trace at all --
        # if Get-CimInstance is ever flaky/slow/throwing on a real machine
        # (CIM/WMI calls repeated every poll from an STA thread are a known
        # rough edge), the companion would silently degrade to "no client"
        # forever with zero diagnostic signal. Logged now (never blocks --
        # still degrades to empty, same as before). v1.2.2: throttled (this
        # runs every 1.5s poll -- an un-throttled log here would flood the
        # 200KB rolling log within minutes if CIM is persistently failing).
        Write-ThrottledErrorLog -Key 'cim-query' -Message "Get-LcuCredentials CIM query failed: $($_.Exception.Message)"
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

# Round-B P3 fix (companion CIM cost): Get-LcuCredentials above shells out to
# Get-CimInstance every call -- Invoke-GameflowTick used to call it
# unconditionally on EVERY 1.5s poll tick, all game, even though the
# port/token pair is stable for the entire lifetime of one LeagueClientUx.exe
# process. Cached here after a successful discovery; only re-discovered when
# the cache is empty (nothing found yet, or it was explicitly cleared) --
# never on a fixed timer of its own, since there's no "this might be stale"
# signal on a schedule, only on an actual failure (see Clear-LcuCredentialsCache
# and its call site in Invoke-GameflowTick, which invalidates on a
# connection-refused/401 LCU response -- the client restarted or rotated its
# token). $Resolver is injectable (defaults to the real Get-LcuCredentials)
# so Invoke-SelfTest can verify "resolver called once across N ticks, called
# again after invalidation" without needing a real LeagueClientUx.exe process.
$script:CachedLcuCreds = $null

function Get-LcuCredentialsCached {
    param([scriptblock]$Resolver = ${function:Get-LcuCredentials})
    if ($script:CachedLcuCreds) { return $script:CachedLcuCreds }
    $creds = & $Resolver
    if ($creds) { $script:CachedLcuCreds = $creds }
    return $creds
}

function Clear-LcuCredentialsCache {
    $script:CachedLcuCreds = $null
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

function Get-TheirTeamChampionIds {
    # v1.4.0 (Draft recommender, plan section 5): enemy champion ids visible
    # in champ-select's theirTeam array -- ON-SCREEN visible info (Riot's
    # anonymity rule bars summoner NAMES only, never champion picks/hovers).
    # IDs only, never names. Each theirTeam member resolves to championId
    # when locked (>0), else championPickIntent when hovering (>0) -- a
    # member who hasn't picked or hovered yet contributes NOTHING (never a 0
    # placeholder, so the app-side array length reflects only real signal).
    param($Session)
    $ids = @()
    if (-not $Session -or -not $Session.theirTeam) { return , $ids }
    foreach ($m in @($Session.theirTeam)) {
        if (-not $m) { continue }
        $cid = [int]$m.championId
        if ($cid -gt 0) { $ids += $cid; continue }
        $intent = [int]$m.championPickIntent
        if ($intent -gt 0) { $ids += $intent }
    }
    return , $ids
}

function Get-TimerPhase {
    # v1.4.0 -- session.timer.phase straight off the LCU (e.g. "PLANNING",
    # "BAN_PICK", "FINALIZATION"), null if the session has no timer object
    # at all (older client behavior, or a session shape this companion
    # hasn't seen). Diagnostic/UX only -- nothing in the scoring or
    # live-sync decision path depends on this.
    param($Session)
    if ($Session -and $Session.timer -and $Session.timer.phase) { return [string]$Session.timer.phase }
    return $null
}

function Set-ChampSelectSnapshot {
    # Diagnostic snapshot for /status's `champSelect` field (remote
    # debugging without a screen-share) -- updated on EVERY poll while in
    # ChampSelect, not just on an open, so a pre-lock hover state is visible
    # even before any open decision is made. Writes into the BRIDGE's own
    # synchronized Sync (a different runspace) when a real bridge exists;
    # no-ops safely in -Mock (no bridge is ever started there).
    param([int]$LocalPlayerCellId, [int]$CellChampionId, [int]$PickIntent, [int]$ActionChampionId, $RoleId, $TheirTeam, $TimerPhase)
    $snapshot = @{
        localPlayerCellId = $LocalPlayerCellId
        cellChampionId    = $(if ($CellChampionId -gt 0) { $CellChampionId } else { $null })
        pickIntent        = $(if ($PickIntent -gt 0) { $PickIntent } else { $null })
        actionChampionId  = $(if ($ActionChampionId -gt 0) { $ActionChampionId } else { $null })
        roleId            = $RoleId
        theirTeam         = @($TheirTeam)
        timerPhase        = $TimerPhase
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

function Test-CompanionHasAttachedTab {
    # v1.3.0 (attached-tab live-follow): a "tab is attached" when the web
    # side has polled /status recently (see companionClient's follow poll,
    # which stamps $Sync.LastStatusPollAt on the bridge side) -- if so,
    # champ-select opens should NOT spawn a NEW tab on every hover change;
    # the already-open tab live-follows via its own poll instead (page.tsx
    # applies the new championId in place). 8s window: generous versus the
    # web poll's own ~3s cadence, tight enough that a genuinely closed tab
    # (no poll in 8s) still gets a fresh Start-Process on the next hover.
    if (-not $script:Bridge -or -not $script:Bridge.Sync -or -not $script:Bridge.Sync.LastStatusPollAt) { return $false }
    try {
        return (New-TimeSpan -Start ([datetime]$script:Bridge.Sync.LastStatusPollAt) -End (Get-Date)).TotalSeconds -lt 8
    } catch {
        return $false
    }
}

function Update-ChampSelectState {
    # Debounce rule (plan section 1): open once per champ-select, re-open ONLY on
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
    $theirTeam = Get-TheirTeamChampionIds -Session $Session
    $timerPhase = Get-TimerPhase -Session $Session

    Set-ChampSelectSnapshot -LocalPlayerCellId $localCellId -CellChampionId $cellChampionId -PickIntent $pickIntent -ActionChampionId $actionChampionId -RoleId $roleId -TheirTeam $theirTeam -TimerPhase $timerPhase

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

    # v1.3.0 (attached-tab live-follow): a tab is ALREADY open and actively
    # polling -- don't spawn a new one on every hover, let it live-follow
    # in place. Debounce state above still advances regardless (so we don't
    # re-decide on every tick for the same champion), we just skip the
    # actual Start-Process this one time.
    $hasAttachedTab = Test-CompanionHasAttachedTab
    if (-not $hasAttachedTab) {
        $url = Get-DeepLinkUrl -AppOrigin $AppOrigin -SessionToken $SessionToken -ChampionId $champId -RoleId $roleId
        Open-CompanionUrl -Url $url
    }
    Set-LastOpen -ChampionId $champId -RoleId $roleId
    Write-CompanionLog "champ-select $(if ($hasAttachedTab) { 'update (tab attached)' } else { 'open' }): champ=$champId role=$(if ($null -ne $roleId) { $roleId } else { 'none' })"
}
#endregion

#region GameflowPoll
function Invoke-GameflowTick {
    if ($script:Bridge -and $script:Bridge.Sync) {
        $script:Bridge.Sync.LastPollAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    # Round-B P3 fix: cached across ticks (was Get-CimInstance every 1.5s
    # poll, all game) -- only re-discovers when the cache is empty, which
    # Test-LcuCallFailure below forces on a connection-refused/401 response
    # (client restarted or its token rotated), never on a fixed schedule.
    $creds = Get-LcuCredentialsCached

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
        if ($r.Ok -and $r.Content) {
            $phase = [string]$r.Content
        } elseif (-not $r.Ok -and ($r.StatusCode -eq 0 -or $r.StatusCode -eq 401)) {
            # Connection refused (client process gone/restarted -- a new one
            # will have a different port/token) or 401 (stale token) -- the
            # cached creds are dead. Drop them so the NEXT tick re-discovers
            # via Get-CimInstance instead of hammering a dead port/token pair
            # every 1.5s until the user notices something's wrong.
            Clear-LcuCredentialsCache
        }
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
            } elseif ($sessRaw.StatusCode -eq 0 -or $sessRaw.StatusCode -eq 401) {
                Clear-LcuCredentialsCache
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
            # v1.3.0 (attached-tab live-follow): stamped on every
            # AUTHORIZED /status GET (session+origin already validated
            # above by the time this branch runs) -- this is how the
            # champ-select open logic below knows a browser tab is still
            # actively polling (i.e. "attached") and should be live-followed
            # in place instead of getting a brand-new Start-Process tab on
            # every hover change.
            $Sync.LastStatusPollAt = (Get-Date).ToUniversalTime().ToString('o')
            Write-JsonResponse -Response $res -StatusCode 200 -Obj @{
                version         = $Sync.Version
                port            = $Sync.BridgePort
                phase           = $Sync.Phase
                clientConnected = [bool]$Sync.LcuPort
                lastOpen        = $Sync.LastOpen
                champSelect     = $(if ($Sync.Phase -eq 'ChampSelect') { $Sync.ChampSelectSnapshot } else { $null })
                lastPollAt      = $Sync.LastPollAt
                lastError       = $Sync.LastError
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
                # mode is validated here, not trusted verbatim: anything
                # other than the literal string 'auto' degrades safely to
                # 'manual' (back-compat default -- a garbage/missing value
                # must never accidentally grant auto mode's different
                # safety posture).
                $mode = 'manual'
                if ($bodyObj -and $bodyObj.mode -eq 'auto') { $mode = 'auto' }
                $result = Invoke-ApplyRunes -Body $bodyObj -LcuPort $Sync.LcuPort -LcuToken $Sync.LcuToken -Scheme $scheme -Mode $mode
                Write-JsonResponse -Response $res -StatusCode 200 -Obj $result
                Write-CompanionLog "apply-runes: ok=$($result.ok) reason=$($result.reason) mode=$mode"
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
                # v1.3.1: $bodyObj.replacePrefix is $null on an older web
                # build that never sends the field (PowerShell dynamic
                # member access on a parsed PSCustomObject returns $null for
                # a missing property) -- Invoke-ApplyItemSets/Merge-ItemSets
                # both treat that as "fall back to the title-derived prefix."
                $result = Invoke-ApplyItemSets -Sets $bodyObj.sets -LcuPort $Sync.LcuPort -LcuToken $Sync.LcuToken -Scheme $scheme -ReplacePrefix $bodyObj.replacePrefix
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
        LastPollAt          = $null
        LastError           = $null
        LastErrorKey        = $null
        LastErrorAt         = $null
        LastStatusPollAt    = $null
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
    # v1.2.1 INCIDENT NOTE (real-mode dead-loop hotfix, live-reported): the
    # gameflow/champ-select loop previously rode a WinForms.Timer Tick event
    # dispatched through Application.Run()'s message pump. Local repro on a
    # dev machine (no League client -- Get-LcuCredentials always null branch)
    # showed that specific path DOES tick reliably; the more likely failure
    # surface is the heavier real-client branch (Get-CimInstance + up to two
    # blocking 5s-timeout HTTPS calls per tick), which -Mock/-SelfTest never
    # exercised end to end (-Mock drives Update-ChampSelectState directly;
    # -SelfTest only exercises the bridge) -- see -HarnessTest below, added
    # specifically to close that blind spot going forward. Replaced the
    # event-based harness with a plain sequential loop regardless: a
    # straight-line loop is strictly easier to reason about than a .NET
    # event delegate invoked by a message pump, and every failure mode
    # considered (an exception mid-tick, a hung HTTPS call, CIM flakiness)
    # degrades the same way here -- logged (Write-CompanionLog, no longer
    # silently swallowed) and retried next iteration, never a dead poll with
    # zero trace. Tray responsiveness (Reopen/Quit) comes from DoEvents(),
    # pumped every 50ms between ticks.
    param(
        # >0 = auto-exit after N seconds (the -DebugRunSeconds / -HarnessTest
        # test seam). 0 = run until Quit is clicked (normal real usage).
        [int]$RunSeconds = 0,
        # Skips NotifyIcon/menu entirely -- lets -HarnessTest drive the EXACT
        # same tick loop headlessly (no Window Station assumptions) while
        # still proving the real gameflow/champ-select code path ticks.
        [switch]$SuppressTray
    )

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
    $script:CompanionRunning = $true
    $script:CachedLcuCreds = $null  # fresh discovery on every real run

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $icon = $null
    if (-not $SuppressTray) {
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
        $quitItem.add_Click({ $script:CompanionRunning = $false })
        $icon.ContextMenuStrip = $menu

        Test-AutoUpdate -Icon $icon
    }

    $pollSw = [System.Diagnostics.Stopwatch]::StartNew()
    $runSw = [System.Diagnostics.Stopwatch]::StartNew()
    try { Invoke-GameflowTick } catch { Write-CompanionLog "gameflow tick error: $($_.Exception.Message)" }

    while ($script:CompanionRunning) {
        if (-not $SuppressTray) { [System.Windows.Forms.Application]::DoEvents() }
        if ($RunSeconds -gt 0 -and $runSw.Elapsed.TotalSeconds -ge $RunSeconds) { break }
        if ($pollSw.ElapsedMilliseconds -ge $script:Config.PollMs) {
            try { Invoke-GameflowTick } catch { Write-CompanionLog "gameflow tick error: $($_.Exception.Message)" }
            $pollSw.Restart()
        }
        Start-Sleep -Milliseconds 50
    }

    if ($icon) { $icon.Visible = $false }
    Stop-BridgeServer -Bridge $script:Bridge
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
        if ($path -eq '/lol-perks/v1/pages' -and $method -eq 'GET') {
            Write-JsonResponse -Response $res -StatusCode 200 -Obj @($Sync.MockPages)
        } elseif ($path -eq '/lol-perks/v1/inventory' -and $method -eq 'GET') {
            if ($null -eq $Sync.MockInventory) {
                Write-JsonResponse -Response $res -StatusCode 404 -Obj @{ error = 'mock-no-inventory' }
            } else {
                Write-JsonResponse -Response $res -StatusCode 200 -Obj $Sync.MockInventory
            }
        } elseif ($path -eq '/lol-perks/v1/currentpage' -and $method -eq 'GET') {
            if ($Sync.MockCurrentPageOverride) {
                # Test-only escape hatch: lets SelfTest simulate a readback
                # that DOESN'T match what was actually posted (a silent
                # partial apply) without needing the real LCU to misbehave.
                Write-JsonResponse -Response $res -StatusCode 200 -Obj $Sync.MockCurrentPageOverride
            } else {
                # @() wraps the WHOLE filtered result (not just the source):
                # a single-match Where-Object result unwraps to a bare
                # object in PS5.1, and .Count on a bare (non-collection)
                # object silently returns $null -- `$null -gt 0` is false,
                # so an unwrapped single match would wrongly 404 here.
                $cur = @(@($Sync.MockPages) | Where-Object { [string]$_.id -eq [string]$Sync.MockCurrentPageId })
                if ($cur.Count -gt 0) {
                    Write-JsonResponse -Response $res -StatusCode 200 -Obj $cur[0]
                } else {
                    Write-JsonResponse -Response $res -StatusCode 404 -Obj @{ error = 'mock-no-current-page' }
                }
            }
        } elseif ($path -eq '/lol-perks/v1/currentpage' -and $method -eq 'PUT') {
            if ($Sync.CurrentPageSelectShouldFail) {
                Write-JsonResponse -Response $res -StatusCode 500 -Obj @{ error = 'mock-select-failed' }
            } else {
                $reader3 = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
                $selectBodyRaw = $reader3.ReadToEnd()
                $reader3.Close()
                $Sync.MockCurrentPageId = ($selectBodyRaw | ConvertFrom-Json)
                $res.StatusCode = 204
                $res.OutputStream.Close()
            }
        } elseif ($path -like '/lol-perks/v1/pages/*' -and $method -eq 'DELETE') {
            if ($Sync.DeleteShouldFail) {
                Write-JsonResponse -Response $res -StatusCode 500 -Obj @{ error = 'mock-delete-failed' }
            } else {
                $deletedId = $path -replace '.*/pages/', ''
                $Sync.MockPages = @(@($Sync.MockPages) | Where-Object { [string]$_.id -ne [string]$deletedId })
                $res.StatusCode = 204
                $res.OutputStream.Close()
            }
        } elseif ($path -eq '/lol-perks/v1/pages' -and $method -eq 'POST') {
            if ($Sync.PagePostShouldFail) {
                Write-JsonResponse -Response $res -StatusCode 400 -Obj @{ error = 'mock-slots-full' }
            } else {
                $reader4 = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
                $postBodyRaw = $reader4.ReadToEnd()
                $reader4.Close()
                $postBodyObj = $postBodyRaw | ConvertFrom-Json
                $newId = $Sync.MockNextPageId
                $Sync.MockNextPageId = $Sync.MockNextPageId + 1
                $newPage = [pscustomobject]@{
                    id                = $newId
                    name              = $postBodyObj.name
                    primaryStyleId    = $postBodyObj.primaryStyleId
                    subStyleId        = $postBodyObj.subStyleId
                    selectedPerkIds   = $postBodyObj.selectedPerkIds
                    isDeletable       = $true
                    isEditable        = $true
                    current           = $false  # v1.3.0 finding: creating a page does NOT select it
                }
                $Sync.MockPages = @(@($Sync.MockPages) + $newPage)
                Write-JsonResponse -Response $res -StatusCode 200 -Obj @{ id = $newId; current = $true }
            }
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
        Running                   = $true
        Listener                  = $listener
        DeleteShouldFail          = $false
        Calls                     = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
        SummonerGetShouldFail     = $false
        ItemSetsGetShouldFail     = $false
        ExistingItemSets          = [pscustomobject]@{ accountId = 1; timestamp = 0; itemSets = @() }
        LastPutBody               = $null
        # Rune-pages mock state (v1.3.0 safety redesign + PUT-currentpage fix)
        MockPages                 = @()
        MockNextPageId            = 20000
        MockCurrentPageId         = $null
        MockInventory             = $null
        CurrentPageSelectShouldFail = $false
        PagePostShouldFail        = $false
        MockCurrentPageOverride   = $null
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
        foreach ($k in 'version', 'port', 'phase', 'clientConnected', 'lastOpen', 'champSelect', 'lastPollAt', 'lastError') {
            if (-not ($obj.PSObject.Properties.Name -contains $k)) { $failures.Add("/status missing field $k") }
        }
        if ($null -ne $obj.lastOpen) { $failures.Add("/status lastOpen expected null before any open, got $($obj.lastOpen)") }
        if ($null -ne $obj.champSelect) { $failures.Add("/status champSelect expected null outside ChampSelect phase, got $($obj.champSelect)") }
    } catch { $failures.Add("/status request threw: $($_.Exception.Message)") }

    # 4b. champSelect snapshot only surfaces while phase==ChampSelect, and
    # reflects whatever Set-ChampSelectSnapshot last wrote (diagnosability).
    # v1.4.0: also covers theirTeam/timerPhase (Draft recommender, plan
    # section 5) round-tripping through the same echo.
    $bridge.Sync.Phase = 'ChampSelect'
    $bridge.Sync.ChampSelectSnapshot = @{ localPlayerCellId = 0; cellChampionId = $null; pickIntent = 103; actionChampionId = $null; roleId = 0; theirTeam = @(45, 91); timerPhase = 'BAN_PICK' }
    try {
        $r = Invoke-WebRequest -Uri "$base/status?session=$session" -Method GET -Headers @{ Origin = $appOrigin } -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.champSelect -or $obj.champSelect.pickIntent -ne 103) {
            $failures.Add("/status champSelect snapshot not echoed correctly: $($r.Content)")
        }
        $gotTheirTeam = @($obj.champSelect.theirTeam)
        if ($gotTheirTeam.Count -ne 2 -or $gotTheirTeam[0] -ne 45 -or $gotTheirTeam[1] -ne 91) {
            $failures.Add("/status champSelect.theirTeam not echoed correctly: $($r.Content)")
        }
        if ($obj.champSelect.timerPhase -ne 'BAN_PICK') {
            $failures.Add("/status champSelect.timerPhase not echoed correctly: $($r.Content)")
        }
    } catch { $failures.Add("/status champSelect request threw: $($_.Exception.Message)") }
    $bridge.Sync.Phase = 'InProgress'
    $bridge.Sync.ChampSelectSnapshot = $null

    $applyBody = @{ name = 'CoachBuild Test Mid'; primaryStyleId = 8000; subStyleId = 8100; selectedPerkIds = @(8005, 9111, 9104, 8014, 8017, 8009, 8017, 5008, 5008); current = $true }

    # 5. apply-runes: free-slot path (no existing pages) -- direct POST, NO
    # delete at all; PUT currentpage selects it; readback verifies content.
    $mockLcu.Sync.MockPages = @()
    $mockLcu.Sync.MockNextPageId = 20000
    $mockLcu.Sync.MockCurrentPageId = $null
    $mockLcu.Sync.MockInventory = $null
    $mockLcu.Sync.CurrentPageSelectShouldFail = $false
    $mockLcu.Sync.PagePostShouldFail = $false
    $mockLcu.Sync.DeleteShouldFail = $false
    $mockLcu.Sync.MockCurrentPageOverride = $null
    $mockLcu.Sync.Calls.Clear()
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($applyBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok) { $failures.Add("apply-runes free-slot path expected ok:true, got $($r.Content)") }
        if ($obj.selected -ne $true) { $failures.Add("apply-runes free-slot path expected selected:true, got $($r.Content)") }
        if ($obj.verified -ne $true) { $failures.Add("apply-runes free-slot path expected verified:true (readback should match), got $($r.Content)") }
        if (@($mockLcu.Sync.Calls) -contains 'DELETE') { $failures.Add('apply-runes free-slot path issued a DELETE with no existing pages') }
    } catch { $failures.Add("apply-runes free-slot path threw: $($_.Exception.Message)") }

    # 6. apply-runes: CoachBuild-page replacement (works in either mode) --
    # an existing CoachBuild page gets DELETEd, a new one created+selected,
    # a non-CoachBuild page is left completely untouched.
    $mockLcu.Sync.MockPages = @(
        [pscustomobject]@{ id = 111; name = 'My Custom Build'; isDeletable = $true }
        [pscustomobject]@{ id = 222; name = 'CoachBuild Test Mid'; isDeletable = $true }
    )
    $mockLcu.Sync.MockCurrentPageId = 222
    $mockLcu.Sync.Calls.Clear()
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($applyBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok -or $obj.selected -ne $true -or $obj.verified -ne $true) {
            $failures.Add("apply-runes CoachBuild-replace path expected ok/selected/verified all true, got $($r.Content)")
        }
        if (@(@($mockLcu.Sync.MockPages) | Where-Object { $_.id -eq 222 }).Count -gt 0) {
            $failures.Add('apply-runes CoachBuild-replace path did not remove the stale CoachBuild page')
        }
        if (@(@($mockLcu.Sync.MockPages) | Where-Object { $_.id -eq 111 }).Count -ne 1) {
            $failures.Add('apply-runes CoachBuild-replace path touched the non-CoachBuild page')
        }
    } catch { $failures.Add("apply-runes CoachBuild-replace threw: $($_.Exception.Message)") }

    # 6b. apply-runes AUTO mode adversarial fixture: 5 user pages, ZERO
    # CoachBuild pages, inventory reports full -- must NEVER issue a single
    # DELETE call and must return slots-full untouched. This is the
    # SelfTest-pinned compliance guarantee from the v1.3.0 safety redesign.
    $mockLcu.Sync.MockPages = @(1..5 | ForEach-Object { [pscustomobject]@{ id = (1000 + $_); name = "User Page $_"; isDeletable = $true } })
    $mockLcu.Sync.MockInventory = @{ ownedPageCount = 5 }
    $mockLcu.Sync.Calls.Clear()
    $autoBody = @{ name = 'CoachBuild Test Mid'; primaryStyleId = 8000; subStyleId = 8100; selectedPerkIds = @(8005, 9111, 9104, 8014, 8017, 8009, 8017, 5008, 5008); current = $true; mode = 'auto' }
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($autoBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if ($obj.ok -ne $false -or $obj.reason -ne 'slots-full') { $failures.Add("apply-runes AUTO-mode adversarial expected slots-full, got $($r.Content)") }
        if (@($mockLcu.Sync.Calls) -contains 'DELETE') { $failures.Add('apply-runes AUTO mode issued a DELETE on a non-CoachBuild page -- compliance violation') }
        if (@($mockLcu.Sync.MockPages).Count -ne 5) { $failures.Add('apply-runes AUTO-mode adversarial mutated the user pages') }
    } catch { $failures.Add("apply-runes AUTO-mode adversarial threw: $($_.Exception.Message)") }

    # 6c. apply-runes MANUAL mode, SAME adversarial 5-page/full fixture --
    # falls back to the ORIGINAL consented behavior (delete currentpage,
    # then POST), since a real click is real consent.
    $mockLcu.Sync.MockCurrentPageId = 1003
    $mockLcu.Sync.Calls.Clear()
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($applyBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok -or $obj.selected -ne $true -or $obj.verified -ne $true) {
            $failures.Add("apply-runes MANUAL-mode fallback expected ok/selected/verified all true, got $($r.Content)")
        }
        if (@($mockLcu.Sync.Calls) -notcontains 'DELETE') { $failures.Add('apply-runes MANUAL-mode fallback never deleted the current page') }
        if (@(@($mockLcu.Sync.MockPages) | Where-Object { $_.id -eq 1003 }).Count -gt 0) {
            $failures.Add('apply-runes MANUAL-mode fallback did not actually remove the deleted page from mock state')
        }
    } catch { $failures.Add("apply-runes MANUAL-mode fallback threw: $($_.Exception.Message)") }
    $mockLcu.Sync.MockInventory = $null

    # 6d. apply-runes readback MISMATCH -- verified:false + a populated
    # mismatch array when the client's actual currentpage content doesn't
    # match what was sent (simulates a partial/silent apply -- the exact
    # failure mode "trust a 2xx blindly" would have hidden).
    $mockLcu.Sync.MockPages = @()
    $mockLcu.Sync.MockCurrentPageId = $null
    $mockLcu.Sync.MockNextPageId = 30000
    $mockLcu.Sync.MockCurrentPageOverride = [pscustomobject]@{ id = 30000; name = 'CoachBuild Test Mid'; selectedPerkIds = @(1, 2, 3, 4, 5, 6, 7, 8, 9) }
    $mockLcu.Sync.Calls.Clear()
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($applyBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok) { $failures.Add("apply-runes mismatch-readback path expected ok:true, got $($r.Content)") }
        if ($obj.selected -ne $true) { $failures.Add("apply-runes mismatch-readback path expected selected:true, got $($r.Content)") }
        if ($obj.verified -ne $false) { $failures.Add("apply-runes mismatch-readback path expected verified:false, got $($r.Content)") }
        if (-not $obj.mismatch -or @($obj.mismatch).Count -eq 0) { $failures.Add("apply-runes mismatch-readback path expected a populated mismatch array, got $($r.Content)") }
    } catch { $failures.Add("apply-runes mismatch-readback threw: $($_.Exception.Message)") }
    $mockLcu.Sync.MockCurrentPageOverride = $null

    # 6e. apply-runes: a failed selection PUT still reports ok:true (the
    # page WAS created) but selected:false -- never falsely implies active.
    $mockLcu.Sync.MockPages = @()
    $mockLcu.Sync.MockCurrentPageId = $null
    $mockLcu.Sync.CurrentPageSelectShouldFail = $true
    $mockLcu.Sync.Calls.Clear()
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($applyBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok) { $failures.Add("apply-runes select-fail path expected ok:true, got $($r.Content)") }
        if ($obj.selected -ne $false) { $failures.Add("apply-runes select-fail path expected selected:false, got $($r.Content)") }
    } catch { $failures.Add("apply-runes select-fail threw: $($_.Exception.Message)") }
    $mockLcu.Sync.CurrentPageSelectShouldFail = $false

    # 6f. apply-runes delete-fail envelope (#1013 fail-soft) -- existing
    # CoachBuild page, DELETE itself fails; must never POST afterward.
    $mockLcu.Sync.MockPages = @([pscustomobject]@{ id = 555; name = 'CoachBuild Test Mid'; isDeletable = $true })
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
    $mockLcu.Sync.DeleteShouldFail = $false
    $mockLcu.Sync.MockPages = @()

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

    # 6f. v1.3.1 -- champ-scoped `replacePrefix` stale removal (live bug
    # fix): a LANE FLIP (Senna Bot -> Support) must remove BOTH the
    # old-lane title AND an old-3-set-era title for the SAME champion, while
    # NEVER touching a non-CoachBuild set or a DIFFERENT champion's
    # CoachBuild set.
    $mockLcu.Sync.ExistingItemSets = [pscustomobject]@{
        accountId = 12345
        timestamp = 1700000000
        itemSets  = @(
            [pscustomobject]@{ uid = 'user-1'; title = 'My Custom Build'; type = 'custom'; blocks = @() }
            [pscustomobject]@{ uid = 'coachbuild-senna-bot'; title = 'CoachBuild Senna Bot'; type = 'custom'; blocks = @() }
            [pscustomobject]@{ uid = 'coachbuild-senna-bot-core'; title = "CoachBuild Senna Bot $([char]0x2014) Core"; type = 'custom'; blocks = @() }
            [pscustomobject]@{ uid = 'coachbuild-viktor-mid'; title = 'CoachBuild Viktor Mid'; type = 'custom'; blocks = @() }
        )
    }
    $sennaSupportSets = @(
        [pscustomobject]@{ uid = 'coachbuild-senna-support'; title = 'CoachBuild Senna Support'; type = 'custom'; map = 'any'; mode = 'any'; associatedMaps = @(); associatedChampions = @(235); preferredItemSlots = @(); sortrank = 0; blocks = @(@{ type = 'Starting'; items = @(@{ id = '1054'; count = 1 }) }) }
    )
    $mockLcu.Sync.LastPutBody = $null
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-itemsets?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes((@{ championId = 235; sets = $sennaSupportSets; replacePrefix = 'CoachBuild Senna ' } | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok -or $obj.count -ne 1) { $failures.Add("apply-itemsets replacePrefix lane-flip expected ok:true count:1, got $($r.Content)") }
        if (-not $mockLcu.Sync.LastPutBody) {
            $failures.Add('apply-itemsets replacePrefix lane-flip never issued a PUT')
        } else {
            $putObj = $mockLcu.Sync.LastPutBody | ConvertFrom-Json
            $putTitles = @($putObj.itemSets | ForEach-Object { $_.title })
            if ($putTitles -contains 'CoachBuild Senna Bot') { $failures.Add('apply-itemsets replacePrefix lane-flip left the OLD-LANE title behind') }
            if ($putTitles -contains "CoachBuild Senna Bot $([char]0x2014) Core") { $failures.Add('apply-itemsets replacePrefix lane-flip left an old-3-set-era title behind') }
            if ($putTitles -notcontains 'CoachBuild Senna Support') { $failures.Add('apply-itemsets replacePrefix lane-flip did not write the new lane set') }
            if ($putTitles -notcontains 'My Custom Build') { $failures.Add('apply-itemsets replacePrefix lane-flip dropped a non-CoachBuild set') }
            if ($putTitles -notcontains 'CoachBuild Viktor Mid') { $failures.Add('apply-itemsets replacePrefix lane-flip touched a DIFFERENT champion''s CoachBuild set') }
        }
    } catch { $failures.Add("apply-itemsets replacePrefix lane-flip threw: $($_.Exception.Message)") }

    # 6g. v1.3.1 -- replacePrefix validation: a value that doesn't start
    # with "CoachBuild" rejects the WHOLE request (invalid-sets), same as a
    # bad title -- never partially applied, never a PUT.
    $mockLcu.Sync.LastPutBody = $null
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-itemsets?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes((@{ championId = 235; sets = $sennaSupportSets; replacePrefix = 'NotCoachBuild Senna ' } | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if ($obj.ok -ne $false -or $obj.reason -ne 'invalid-sets') { $failures.Add("apply-itemsets bad replacePrefix expected invalid-sets rejection, got $($r.Content)") }
        if ($mockLcu.Sync.LastPutBody) { $failures.Add('apply-itemsets issued a PUT with an invalid replacePrefix') }
    } catch { $failures.Add("apply-itemsets bad replacePrefix threw: $($_.Exception.Message)") }

    # 6e. v1.2.2 -- a real Invoke-LcuRaw failure (point LcuPort at a port
    # nothing listens on) must populate /status's lastError. This is the
    # exact gap that shipped invisibly in v1.2.1: the failing call's own
    # catch block swallowed the exception one layer below where logging had
    # been added.
    $bridge.Sync.LcuPort = 59999
    $bridge.Sync.LastError = $null
    $bridge.Sync.LastErrorKey = $null
    $bridge.Sync.LastErrorAt = $null
    try {
        Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($applyBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing | Out-Null
        Start-Sleep -Milliseconds 300
        $statusResp = Invoke-WebRequest -Uri "$base/status?session=$session" -Method GET -Headers @{ Origin = $appOrigin } -UseBasicParsing
        $statusObj = $statusResp.Content | ConvertFrom-Json
        if (-not $statusObj.lastError) {
            $failures.Add('lastError never populated after a real Invoke-LcuRaw failure (unreachable port) -- v1.2.1-class blind spot has regressed')
        } elseif ($statusObj.lastError -notlike '*Invoke-LcuRaw failed*') {
            $failures.Add("lastError populated but doesn't look like the expected message: $($statusObj.lastError)")
        }
    } catch { $failures.Add("lastError repro threw: $($_.Exception.Message)") }

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

    # 9. LCU credentials cache (Round-B P3 fix) -- resolver (stands in for
    # the real Get-CimInstance-backed Get-LcuCredentials) must be called
    # exactly once across repeated ticks, and again only after an explicit
    # invalidation (the connection-refused/401 path in Invoke-GameflowTick).
    $script:CachedLcuCreds = $null
    $script:__lcuSelfTestResolveCount = 0
    $fakeLcuResolver = {
        $script:__lcuSelfTestResolveCount++
        [pscustomobject]@{ Port = 65000; Token = 'faketoken'; Source = 'selftest-fake' }
    }
    $c1 = Get-LcuCredentialsCached -Resolver $fakeLcuResolver
    $c2 = Get-LcuCredentialsCached -Resolver $fakeLcuResolver
    $c3 = Get-LcuCredentialsCached -Resolver $fakeLcuResolver
    if ($script:__lcuSelfTestResolveCount -ne 1) {
        $failures.Add("LCU creds cache: resolver called $($script:__lcuSelfTestResolveCount) times across 3 ticks, expected exactly 1 (cache not being reused)")
    }
    if ($c1.Port -ne 65000 -or $c2.Port -ne 65000 -or $c3.Port -ne 65000) {
        $failures.Add('LCU creds cache: cached creds were not returned consistently across ticks')
    }
    Clear-LcuCredentialsCache
    $c4 = Get-LcuCredentialsCached -Resolver $fakeLcuResolver
    if ($script:__lcuSelfTestResolveCount -ne 2) {
        $failures.Add("LCU creds cache: invalidation did not force re-discovery on the next tick (resolve count $($script:__lcuSelfTestResolveCount), expected 2)")
    }
    if ($c4.Port -ne 65000) { $failures.Add('LCU creds cache: re-discovery after invalidation did not return fresh creds') }
    Clear-LcuCredentialsCache  # leave global state clean for anything run after SelfTest in-process

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

#region HarnessTest
function Invoke-HarnessTest {
    # v1.2.1 -- closes the exact blind spot that let a dead real-mode loop
    # ship undetected: -Mock drives Update-ChampSelectState directly (never
    # runs Start-Companion's actual loop) and -SelfTest only ever exercises
    # the bridge server, never the gameflow-poll harness around it. This
    # spawns a REAL `-DebugRunSeconds` child process (tray suppressed, no
    # League client needed) and asserts /status's `lastPollAt` heartbeat
    # genuinely advances between two polls -- if the real loop ever dies
    # again (event-handler regression, an unhandled exception, whatever),
    # this fails loudly instead of shipping silently.
    $failures = New-Object System.Collections.Generic.List[string]
    $proc = $null
    try {
        $proc = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-DebugRunSeconds', '10') `
            -PassThru -WindowStyle Hidden

        $sessionPath = Join-Path (Join-Path $env:LOCALAPPDATA 'CoachBuild') 'companion-session.txt'
        $token = $null
        for ($i = 0; $i -lt 40 -and -not $token; $i++) {
            Start-Sleep -Milliseconds 250
            if (Test-Path $sessionPath) {
                $candidate = (Get-Content -Path $sessionPath -Raw -ErrorAction SilentlyContinue).Trim()
                if ($candidate) { $token = $candidate }
            }
        }
        if (-not $token) { $failures.Add('HarnessTest: session token file never appeared -- Start-Companion never reached Get-OrCreateSessionToken') }

        $base = $null
        $first = $null
        if ($token) {
            for ($i = 0; $i -lt 20 -and -not $first; $i++) {
                foreach ($p in 48291, 48292, 48293) {
                    try {
                        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/status?session=$token" -Method GET -Headers @{ Origin = 'https://coachbuild.vercel.app' } -UseBasicParsing -TimeoutSec 2
                        $first = $r.Content | ConvertFrom-Json
                        $base = "http://127.0.0.1:$p"
                        break
                    } catch { continue }
                }
                if (-not $first) { Start-Sleep -Milliseconds 250 }
            }
        }

        if (-not $first) {
            $failures.Add('HarnessTest: /status never answered on any bridge port -- the bridge itself never came up in real mode')
        } else {
            foreach ($k in 'phase', 'lastPollAt', 'clientConnected', 'lastOpen', 'champSelect') {
                if (-not ($first.PSObject.Properties.Name -contains $k)) { $failures.Add("HarnessTest: /status missing field $k") }
            }
            if (-not $first.lastPollAt) {
                $failures.Add('HarnessTest: lastPollAt was null on first successful poll -- the real gameflow-poll loop never ticked even once')
            } else {
                Start-Sleep -Milliseconds 3000
                $r2 = Invoke-WebRequest -Uri "$base/status?session=$token" -Method GET -Headers @{ Origin = 'https://coachbuild.vercel.app' } -UseBasicParsing -TimeoutSec 2
                $second = $r2.Content | ConvertFrom-Json
                if (-not $second.lastPollAt -or ([datetime]$second.lastPollAt) -le ([datetime]$first.lastPollAt)) {
                    $failures.Add("HarnessTest: lastPollAt did not advance (first=$($first.lastPollAt) second=$($second.lastPollAt)) -- the real-mode loop is DEAD")
                }
            }
        }
    } finally {
        try { if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } catch {}
        # Belt-and-braces: kill any lingering child by commandline match too
        # (the harness process may itself be a different PID than $proc if
        # powershell.exe re-execs) -- never leave a real-mode instance
        # running after this test, on this or any other machine.
        try {
            Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -like '*-DebugRunSeconds*' } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        } catch {}
    }

    if ($failures.Count -gt 0) {
        Write-Host "HARNESSTEST FAILED ($($failures.Count)):" -ForegroundColor Red
        $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
        exit 1
    } else {
        Write-Host 'HARNESSTEST PASSED' -ForegroundColor Green
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
        param([int]$ChampId, [int]$IntentId, [string]$Position, $Actions = @(), $TheirTeam = @(), $TimerPhase = $null)
        $timer = $null
        if ($TimerPhase) { $timer = [pscustomobject]@{ phase = $TimerPhase } }
        return [pscustomobject]@{
            localPlayerCellId = 0
            myTeam            = @([pscustomobject]@{ cellId = 0; championId = $ChampId; championPickIntent = $IntentId; assignedPosition = $Position })
            theirTeam         = $TheirTeam
            timer             = $timer
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

    # theirTeam + timerPhase resolution (v1.4.0 -- Draft recommender feed,
    # plan section 5): enemy champion ids (locked championId, else visible
    # pickIntent fallback -- IDs ONLY, never names) + the session timer's
    # phase land in the same snapshot /status echoes (Set-ChampSelectSnapshot).
    # Verified via $script:ChampSelectSnapshotRecord, which is always written
    # even in -Mock (no real bridge exists here -- see Set-ChampSelectSnapshot).
    $script:OpenActions.Clear()
    $theirTeamState = @{ LastOpenedChampId = $null }
    $theirTeamFixture = @(
        [pscustomobject]@{ cellId = 5; championId = 45; championPickIntent = 0 }   # locked
        [pscustomobject]@{ cellId = 6; championId = 0; championPickIntent = 91 }   # hovering only
        [pscustomobject]@{ cellId = 7; championId = 0; championPickIntent = 0 }    # nothing yet -- must be omitted
    )
    Update-ChampSelectState -State $theirTeamState -Session (New-MockChampSelectSession -ChampId 103 -IntentId 103 -Position 'top' -TheirTeam $theirTeamFixture -TimerPhase 'BAN_PICK') -AppOrigin $appOrigin -SessionToken $sessionToken
    $snap = $script:ChampSelectSnapshotRecord
    $gotTheirTeam = @($snap.theirTeam)
    if ($gotTheirTeam.Count -ne 2 -or $gotTheirTeam[0] -ne 45 -or $gotTheirTeam[1] -ne 91) {
        $failures.Add("theirTeam resolution mismatch: got $($gotTheirTeam -join ',')")
    }
    if ($snap.timerPhase -ne 'BAN_PICK') {
        $failures.Add("timerPhase mismatch: got $($snap.timerPhase)")
    }
    # timerPhase is null when the session has no timer object at all.
    Update-ChampSelectState -State $theirTeamState -Session (New-MockChampSelectSession -ChampId 103 -IntentId 103 -Position 'top' -TheirTeam @() -TimerPhase $null) -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($null -ne $script:ChampSelectSnapshotRecord.timerPhase) {
        $failures.Add("timerPhase expected null when session.timer is absent, got $($script:ChampSelectSnapshotRecord.timerPhase)")
    }

    # Attached-tab gate (v1.3.0 live-follow fold-in): a fresh
    # $script:Bridge.Sync.LastStatusPollAt (the web side is actively
    # polling /status, i.e. a tab is still open and will live-follow)
    # suppresses Open-CompanionUrl on a champion CHANGE; a stale/absent one
    # (no tab attached) still opens exactly as before. -Mock fakes a
    # lightweight $script:Bridge (no real HttpListener) purely so
    # Test-CompanionHasAttachedTab has something to read.
    $script:Bridge = [pscustomobject]@{ Sync = @{ LastStatusPollAt = $null } }
    $attachState = @{ LastOpenedChampId = $null }

    # No attached tab (LastStatusPollAt never set) -> opens as normal.
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 103 -IntentId 103 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 1) {
        $failures.Add("Attached-tab gate: expected an open with no attached tab, got $($script:OpenActions.Count)")
    }

    # Fresh poll (tab attached) -> a champion CHANGE must NOT open a new tab
    # -- debounce state still advances (the tab itself follows via poll).
    $script:Bridge.Sync.LastStatusPollAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 7 -IntentId 7 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 0) {
        $failures.Add("Attached-tab gate: expected NO open with a fresh attached tab, got $($script:OpenActions.Count)")
    }
    if ($attachState.LastOpenedChampId -ne 7) {
        $failures.Add('Attached-tab gate: debounce state did not advance even though the tab-follow path is responsible for it')
    }

    # Poll goes stale (tab presumably closed) -> the NEXT champion change
    # resumes opening a fresh tab.
    $script:Bridge.Sync.LastStatusPollAt = (Get-Date).ToUniversalTime().AddSeconds(-30).ToString('o')
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 64 -IntentId 64 -Position 'jungle') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 1) {
        $failures.Add("Attached-tab gate: expected open to resume once the poll goes stale, got $($script:OpenActions.Count)")
    }
    $script:Bridge = $null

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
} elseif ($HarnessTest) {
    Invoke-HarnessTest
} elseif ($Mock) {
    Invoke-MockRun -Once:$Once
} elseif ($Install) {
    Install-Companion
} elseif ($Uninstall) {
    Uninstall-Companion
} elseif ($DebugRunSeconds -gt 0) {
    Start-Companion -RunSeconds $DebugRunSeconds -SuppressTray
} else {
    Start-Companion
}
#endregion
