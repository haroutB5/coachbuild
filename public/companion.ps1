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
                                pre-1.3.0 web builds),
                              replacePrefix?:string (v1.6.3 -- champ-scoped
                                "CoachBuild <champ> "; if present MUST start
                                with "CoachBuild" or it's ignored; drives the
                                champ-change stale cleanup below. $null on an
                                older web build -> no cleanup, exact-title
                                match only)}
                       -> 200 {ok:true, selected:boolean, verified:boolean,
                                mismatch:string[]}
                        | 200 {ok:false, reason:string, hint?:string}
    v1.6.3 TWO-PAGE MODEL (user-reported: "pro runes get reverted"): the WPA
    auto-export writes "CoachBuild <champ> <role>" and the manual "Apply pro
    runes" button writes "CoachBuild <champ> <role> Pro" -- TWO distinct
    titles that must COEXIST as two separate LCU rune pages. Before 1.6.3 the
    handler matched ANY "CoachBuild"-prefixed page and edited the oldest in
    place, so both writes fought over ONE physical page (each renamed/
    overwrote the other -> the revert). Now each apply targets its OWN
    EXACT-TITLE page.
    Page-selection logic (BOTH modes): GET /lol-perks/v1/pages (only
    isDeletable:true pages count -- preset/default pages never do).
    STEP 1 -- champ-scoped stale cleanup (only when replacePrefix is present
    and starts with "CoachBuild"): DELETE our OWN pages titled "CoachBuild*"
    whose title does NOT start with replacePrefix (i.e. OTHER champions'
    pages). This bounds us at the current champ's <=2 pages. A page starting
    with replacePrefix is NEVER deleted -- that protects BOTH the current
    champ's WPA and Pro pages from cross-deletion. A non-"CoachBuild" page is
    NEVER touched (hard invariant). Fail-soft: a delete the LCU refuses (e.g.
    a currently-selected stale page) is skipped, never aborts the apply (it
    self-heals next cycle once it's no longer selected).
    STEP 2 -- EXACT-TITLE match on body.name: a page whose title EQUALS
    body.name exactly (never a mere prefix; the WPA page and the Pro page are
    distinct exact titles) -> EDIT IT IN PLACE via PUT /lol-perks/v1/pages/{id}
    (full LolPerksPerkPageResource body: id + name + primaryStyleId +
    subStyleId + selectedPerkIds + current) -> then select + readback-verify.
    NO delete of our own page (v1.6.2 root-cause fix: the LCU refuses to
    DELETE the currently-selected page -> delete-failed -> nothing applied).
    Edit fails -> {ok:false, reason:'edit-failed', hint (status-coded)}; we do
    NOT fall back to delete+create on an edit failure (the page is likely
    still selected, so a delete would fail the same way -- reintroducing the
    bug).
    STEP 3 -- no exact-title page yet -> is there a free slot (GET
    /lol-perks/v1/inventory ownedPageCount vs the editable-page count after
    cleanup when available; else a speculative POST, since the LCU itself
    rejects a full inventory) -> POST directly, no delete at all. Genuinely
    full AND no exact-title page to edit: mode='manual' (a real user click =
    real consent) falls back to the ORIGINAL behavior -- GET currentpage ->
    DELETE it -> POST; mode='auto' NEVER deletes a page it doesn't own ->
    {ok:false, reason:'slots-full', hint:'all rune pages are yours -- click
    Apply runes to replace the current one'}.
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
    reason:'read-failed'}); PUT back every other top-level field
    (accountId, timestamp, etc.) byte-for-byte untouched.
    v1.6.1 PAYLOAD-BOUND PRUNE (413 fix): keep ONLY the set(s) being written
    this call (the CURRENT champion+role) and DROP every pre-existing
    CoachBuild-titled set -- this champion's stale roles AND every other
    champion's accumulated sets. The OLD behavior kept every other
    champion's CoachBuild set forever; combined with v0.43.0's fuller
    ~10-block sets, the whole-object PUT eventually exceeded the LCU's
    item-sets size limit -> HTTP 413 rejected the ENTIRE write, so NONE of
    the CoachBuild sets landed (both the "413" toast AND "my Tank/Mage
    category builds aren't in-game" are this one rejected PUT). Keeping only
    the current set bounds OUR payload contribution at O(1) instead of
    O(champions ever viewed). HARD INVARIANT (SelfTest-pinned): the prune
    boundary is the LITERAL generic prefix "CoachBuild" -- a set whose title
    does NOT start with "CoachBuild" is NEVER dropped (the user's own
    hand-made sets always survive byte-for-byte). `replacePrefix` is still
    accepted + validated (wire back-compat) but is no longer the prune
    boundary -- the generic "CoachBuild" literal drops a strict superset of
    what any champ-scoped prefix would, exactly the payload-bounding wanted.
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
  - v1.6.0 ("two pages simultaneously" ship, user directive 2026-07-22):
    a champion resolution that passes the debounce now opens the MISSING
    page(s) of a TWO-page set -- the Builds deep-link above AND
    "<AppOrigin>/draft?session=<token>" (Get-DraftDeepLinkUrl, no
    championId/role -- /draft live-syncs entirely off its own /status poll,
    see CompanionProvider.tsx) -- rather than only ever opening Builds.
    Per-page attachment is now tracked independently
    (Test-CompanionHasAttachedTab -Kind builds|draft, replacing the single
    v1.3.0/v1.5.0 LastFollowPollAt with LastBuildsFollowAt/
    LastDraftFollowAt): both missing -> open Builds FIRST, then /draft LAST
    (Start-Process order is best-effort OS-level focus order -- lands the
    user on /draft as the main focus page per the directive, in the common
    case); only draft attached -> open Builds only; only Builds attached ->
    open /draft only (this necessarily focuses the newly-opened Builds tab
    instead -- an unavoidable consequence of Start-Process, not a violation
    of the "draft as main focus" intent, which is specifically about the
    both-missing case); both attached -> no opens (both already live-follow
    via their own polls). See Update-ChampSelectState's own comment for the
    exact decision table.
  - v1.7.0 ("browser closed -> pages never open", live-reported 2026-07-26):
    three related fixes to "the pages are ready when champ-select starts."
    (a) PRE-WARM. Both pages are now opened on champ-select ENTRY
    (Invoke-ChampSelectPrewarm), not on the first champion resolution --
    Builds via a session-only "<AppOrigin>/?session=<token>" (no championId
    yet; the tab adopts the session and then live-follows the hover in
    place, exactly like a manually-opened tab always could) and /draft via
    its usual URL. A cold browser therefore boots during bans instead of
    mid-hover, which is what "ready" means. Update-ChampSelectState's
    decision table is UNCHANGED -- the pre-warm just means its opens are
    normally already covered by the open->attach grace / a real follow poll.
    (b) EXPLICIT DETACH. `follow=<kind>&detach=1` on /status clears that
    kind's attach stamp and records LastBuildsDetachAt/LastDraftDetachAt.
    The web side sends it on `pagehide` and when a client-side nav leaves a
    follow-capable route (CompanionProvider.tsx). Without this, closing the
    browser left a stamp that looked attached for the full
    AttachWindowSeconds (150s, i.e. most of a champ-select) and NOTHING
    opened -- the exact live-reported symptom. A detach newer than the last
    open also voids the open->attach grace (the tab is provably gone, so
    the grace has nothing left to protect).
    (c) BROWSER-LIVENESS GUARD. A stamp is only trusted while some browser
    process actually exists (Test-BrowserProcessRunning). This catches the
    hard-kill case where no pagehide ever fires (task-kill, crash, sign-out).
    It can only ever WIDEN opening -- it never suppresses an open that the
    old logic would have made -- so it cannot regress v1.6.4's tab-spam fix.

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
    Version     = '1.7.0'
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
    # both serve self-signed loopback certs, so an accept-all callback is
    # needed for THOSE two targets.
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
    #
    # v1.6.5 SCOPING FIX (2026-07-26 audit P2 security): ServicePointManager
    # .ServerCertificateValidationCallback is PROCESS-WIDE -- the old
    # AlwaysTrue delegate accepted ANY server's cert, including the ONE
    # non-loopback HTTPS target this script ever calls, coachbuild.vercel.app
    # (Test-AutoUpdate's companion.version check). Blast radius was already
    # small (a version-check GET, response only ever feeds a balloon-tip
    # string -- see this file's SelfTest/CLAUDE.md audit notes; the
    # irm|iex install/update chain is separately proven NOT MITM-able via
    # this shim, since it always spawns a FRESH powershell.exe where the
    # shim hasn't run) but real: a network attacker could MITM that one call
    # today. ValidateLoopbackOnly below scopes the accept-all behaviour to
    # loopback targets (127.0.0.1 -- the LCU and Live Client Data APIs) only;
    # every other host gets REAL certificate validation
    # (sslPolicyErrors == None). The sender .NET hands the callback for an
    # HttpWebRequest-backed call (what Invoke-WebRequest/Invoke-RestMethod
    # use on PS 5.1 Desktop) is commonly the ServicePoint, not the
    # HttpWebRequest itself -- both shapes are checked, and ANY unrecognized
    # sender shape falls through to standard validation rather than widening
    # trust, so a type-inspection miss can only ever make the shim STRICTER
    # than before, never looser. This still avoids the scriptblock
    # runspace-affinity trap above: the whole callback is compiled code.
    if (-not ([System.Management.Automation.PSTypeName]'CoachBuildCertPolicy').Type) {
        Add-Type -TypeDefinition @"
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
public static class CoachBuildCertPolicy {
    public static bool ValidateLoopbackOnly(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors sslPolicyErrors) {
        try {
            System.Uri targetUri = null;
            HttpWebRequest req = sender as HttpWebRequest;
            if (req != null) {
                targetUri = req.RequestUri;
            } else {
                ServicePoint sp = sender as ServicePoint;
                if (sp != null) { targetUri = sp.Address; }
            }
            if (targetUri != null && targetUri.IsLoopback) {
                return true;
            }
        } catch {
            // Any unexpected sender shape falls through to real validation
            // below -- never widen trust on a type-inspection failure.
        }
        return sslPolicyErrors == SslPolicyErrors.None;
    }
    public static void Apply() { ServicePointManager.ServerCertificateValidationCallback = ValidateLoopbackOnly; }
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
        return [pscustomobject]@{ Ok = $true; StatusCode = [int]$res.StatusCode; Content = $content; Body = $null }
    } catch {
        $status = 0
        try { if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode } } catch {}
        # v1.5.1: capture the LCU's own error-response BODY (first ~200
        # chars) for diagnostics -- ErrorDetails.Message is how Windows
        # PowerShell 5.1's Invoke-WebRequest surfaces a non-2xx response
        # body on a terminating error (the exception object itself carries
        # no body text). Logged only (throttled, below) -- NEVER surfaced
        # verbatim to the user; a caller-facing hint gets the numeric status
        # code alone (see Get-LcuFailureHint), since the raw body is
        # arbitrary LCU-internal text that could be confusing or leak
        # internal detail.
        $bodySnippet = $null
        try {
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
                $raw = [string]$_.ErrorDetails.Message
                $bodySnippet = if ($raw.Length -gt 200) { $raw.Substring(0, 200) } else { $raw }
            }
        } catch {}
        # v1.2.2: this used to swallow the exception with ZERO trace -- the
        # exact gap that let a real "every LCU call dies" failure ship
        # invisibly (companion.log showed nothing past startup even while
        # sitting in a live champ select). Throttled (see
        # Write-ThrottledErrorLog) so a persistent failure logs once per
        # ~60s, not once per 1.5s poll.
        $logMsg = "Invoke-LcuRaw failed: $Method $Path -- $($_.Exception.GetType().Name): $($_.Exception.Message) (status=$status)"
        if ($bodySnippet) { $logMsg += " | body: $bodySnippet" }
        Write-ThrottledErrorLog -Key "lcu:$Method $Path" -Message $logMsg
        return [pscustomobject]@{ Ok = $false; StatusCode = $status; Content = $null; Body = $bodySnippet }
    }
}

function Get-LcuFailureHint {
    # Shared hint-builder for a failed Invoke-LcuRaw call, used by every
    # apply-* path that doesn't already have a more specific fixed hint
    # (read-failed/delete-failed/slots-full/invalid-sets all set their own).
    # StatusCode 0 (no response at all -- connection refused/timeout) or 401
    # (stale auth token) are the exact same "the LCU we resolved credentials
    # for is no longer there" condition Invoke-GameflowTick already treats
    # as cache-invalidating (see its own `-eq 0 -or -eq 401` check below) --
    # from the user's side this is transient and self-healing (the next
    # ~1.5s poll tick re-discovers a live client on its own), so it earns a
    # reassuring hint rather than being lumped in with a genuine LCU-side
    # rejection. Any other non-zero status is a real rejection the LCU
    # actively returned -- surface the numeric code (never the raw body;
    # that's throttled-log-only, see Invoke-LcuRaw) plus a targeted
    # suggestion.
    param([int]$StatusCode, [string]$Action)
    if ($StatusCode -eq 0 -or $StatusCode -eq 401) {
        return 'companion lost the client connection -- it re-detects automatically, try again in a few seconds'
    }
    return "League client rejected the $Action (HTTP $StatusCode) -- make sure you're logged in and not mid-game"
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
    #
    # v1.6.2: takes the page id EXPLICITLY (-PageId) rather than digging it
    # out of a POST response, so this same select-then-verify tail serves
    # BOTH the create paths (id from the POST response body) AND the new
    # PUT-in-place edit path (id already known -- it's the CoachBuild page we
    # just overwrote; a PUT edit may return 204/no body, so there's no
    # response id to read).
    param($PageId, $Body, [int]$LcuPort, [string]$LcuToken, [string]$Scheme)
    $pageId = $PageId
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
    # auto-fire (could silently wipe a page that isn't ours at all). Auto mode
    # NEVER deletes a non-CoachBuild page -- SelfTest-pinned (adversarial
    # 5-page, 0-CoachBuild fixture must produce zero DELETE calls).
    #
    # v1.6.3 TWO-PAGE MODEL (user-reported "pro runes get reverted"): the WPA
    # auto-export writes "CoachBuild <champ> <role>" and the manual "Apply pro
    # runes" button writes "CoachBuild <champ> <role> Pro". Those two titles
    # must coexist as TWO physical pages. The pre-1.6.3 handler edited the
    # OLDEST "CoachBuild*"-prefixed page in place regardless of its exact
    # title, so the two writes overwrote/renamed one shared page (the revert).
    # New logic: (1) champ-scoped stale cleanup of OTHER champs' pages, then
    # (2) EXACT-TITLE match (edit-in-place) or (3) create.
    #
    # Bug #1013 (RiotGames/developer-relations): DELETE on an isDeletable
    # page can falsely fail -- fail SOFT everywhere (never attempt a POST
    # after a failed delete) and surface a manual-delete hint instead of
    # retrying or forcing anything.
    param($Body, [int]$LcuPort, [string]$LcuToken, [string]$Scheme = 'https', [string]$Mode = 'manual')

    # Title gate FIRST, before a single LCU call: an unownable title must never
    # reach STEP 2's exact-title PUT. See Test-RunePayload for why this was
    # missing and why SelfTest could not see it.
    if (-not (Test-RunePayload -Body $Body)) {
        return @{ ok = $false; reason = 'invalid-page' }
    }

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

    # -- STEP 1: champ-scoped stale cleanup (v1.6.3) ----------------------------
    # Delete OUR OWN pages ("CoachBuild*") for OTHER champions so we stay
    # bounded at the current champ's <=2 pages (WPA + Pro). Gated on a valid
    # replacePrefix ("CoachBuild <champ> ", trailing space load-bearing).
    #   - A page starting with replacePrefix is NEVER deleted -> protects BOTH
    #     the current champ's WPA and Pro pages from cross-deletion (applying
    #     WPA must not wipe the Pro page, and vice-versa).
    #   - A non-"CoachBuild" page is NEVER touched (hard invariant, shared with
    #     the auto-mode zero-foreign-mutation guarantee).
    #   - Fail-soft: a delete the LCU refuses (e.g. a stale page that's still
    #     the currently-selected page) is skipped, not fatal -- it self-heals
    #     next cycle once our new page is selected instead.
    # $null replacePrefix (older web build) -> skip cleanup entirely and rely on
    # exact-title matching alone (no accumulation guarantee, but never a wrong
    # deletion).
    $prefix = if ($Body.replacePrefix) { [string]$Body.replacePrefix } else { $null }
    if ($prefix -and $prefix.StartsWith('CoachBuild')) {
        $stalePages = @($editablePages | Where-Object {
            $_.name -and ([string]$_.name).StartsWith('CoachBuild') -and -not ([string]$_.name).StartsWith($prefix)
        })
        $anyDeleted = $false
        foreach ($stale in $stalePages) {
            $del = Invoke-LcuRaw -Method DELETE -Path "/lol-perks/v1/pages/$($stale.id)" -Port $LcuPort -Token $LcuToken -Scheme $Scheme
            if ($del.Ok) { $anyDeleted = $true }
            # fail-soft: ignore a failed delete (LCU refuses a selected page)
        }
        if ($anyDeleted) {
            # Re-read so the slot math + exact-title match below reflect the
            # freed slots. A failed re-read leaves $editablePages as-is (still
            # correct enough -- worst case a spurious slots-full, never a wrong
            # write).
            $pagesResult = Invoke-LcuRaw -Method GET -Path '/lol-perks/v1/pages' -Port $LcuPort -Token $LcuToken -Scheme $Scheme
            if ($pagesResult.Ok) {
                $editablePages = @(@($pagesResult.Content) | Where-Object { $_.isDeletable -eq $true })
            }
        }
    }

    # -- STEP 2: EXACT-TITLE match -> edit-in-place -----------------------------
    # This apply owns EXACTLY the page whose title EQUALS $Body.name (the WPA
    # page "CoachBuild <champ> <role>" or the Pro page "... Pro" -- never the
    # sibling, whose title differs). Match by exact equality, NOT StartsWith, so
    # "CoachBuild Teemo Top" can never target "CoachBuild Teemo Top Pro".
    $exactMatches = @($editablePages | Where-Object { $_.name -and ([string]$_.name -eq [string]$Body.name) })
    if ($exactMatches.Count -gt 0) {
        # v1.6.2 ROOT-CAUSE FIX: EDIT IN PLACE (never delete), oldest by id if
        # somehow duplicated. Overwriting OUR OWN page's contents is exactly as
        # compliance-safe as delete+create and sidesteps the "LCU refuses to
        # delete the selected page" wall (the exact delete-failed bug). We do
        # NOT fall back to delete+create on an edit failure: the page is likely
        # still selected, so a delete would fail the same way.
        $target = ($exactMatches | Sort-Object -Property id)[0]
        # Include its id in the body (LolPerksPerkPageResource) so the LCU
        # edits this exact page rather than treating it as a create.
        $editBody = @{
            id              = $target.id
            name            = $Body.name
            primaryStyleId  = $Body.primaryStyleId
            subStyleId      = $Body.subStyleId
            selectedPerkIds = $Body.selectedPerkIds
            current         = $true
        }
        $put = Invoke-LcuRaw -Method PUT -Path "/lol-perks/v1/pages/$($target.id)" -Body $editBody -Port $LcuPort -Token $LcuToken -Scheme $Scheme
        if (-not $put.Ok) {
            return [pscustomobject]@{ ok = $false; reason = 'edit-failed'; hint = (Get-LcuFailureHint -StatusCode $put.StatusCode -Action 'rune page edit') }
        }
        # Select (reaffirm) + readback-verify against the page we just edited.
        return Complete-RuneApply -PageId $target.id -Body $Body -LcuPort $LcuPort -LcuToken $LcuToken -Scheme $Scheme
    }

    # -- STEP 3: no exact-title page yet -- is there a free slot? Prefer the
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
        if ($post.Ok) { return Complete-RuneApply -PageId $post.Content.id -Body $Body -LcuPort $LcuPort -LcuToken $LcuToken -Scheme $Scheme }
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
        if (-not $post2.Ok) {
            return [pscustomobject]@{ ok = $false; reason = 'create-failed'; hint = (Get-LcuFailureHint -StatusCode $post2.StatusCode -Action 'new rune page') }
        }
        return Complete-RuneApply -PageId $post2.Content.id -Body $Body -LcuPort $LcuPort -LcuToken $LcuToken -Scheme $Scheme
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

function Test-RunePayload {
    # Defense-in-depth, the rune-side twin of Test-ItemSetsPayload.
    #
    # WHY THIS WAS MISSING AND WHY IT MATTERS. This file's header and CLAUDE.md
    # HARD RULE 5 both state the bright line as "only ever replaces a page it
    # PREVIOUSLY created (title starts with CoachBuild) or uses a genuinely free
    # slot" -- but Invoke-ApplyRunes STEP 2 only ever matched
    # `$_.name -eq $Body.name` with $Body.name caller-supplied and unchecked.
    # A POST of {name:"Ranked Page 1", mode:"auto", ...} therefore exact-title
    # matched the user's OWN hand-made page and PUT-overwrote its perks in place.
    #
    # It issues no DELETE, which is exactly why the adversarial SelfTest suite
    # never caught it: every assertion guarding this invariant is DELETE-shaped
    # ("$mockLcu.Sync.Calls -contains 'DELETE'"). A guarantee the docs assert and
    # the code does not implement is worse than no guarantee, because it stops
    # anyone from looking. The item-set path has had this gate since v1.3.1; the
    # rune path never got its counterpart.
    #
    # Not reachable from the shipped web build (runeApplyBody.ts hardcodes the
    # "CoachBuild <champ> <role>" title), so this closes a defense-in-depth hole
    # rather than a live exploit -- it costs 3 lines and removes the asymmetry.
    param($Body)
    if (-not $Body) { return $false }
    if (-not $Body.name) { return $false }
    if (-not ([string]$Body.name).StartsWith('CoachBuild')) { return $false }
    # Same treatment as the item-set path: an explicit stale-removal prefix can
    # touch arbitrary existing pages, so a PRESENT-but-wrong prefix is rejected
    # while an absent one ($null, older web build) passes.
    if ($Body.replacePrefix -and -not ([string]$Body.replacePrefix).StartsWith('CoachBuild')) { return $false }
    return $true
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
    # passes through UNTOUCHED; only .itemSets is rebuilt.
    #
    # v1.6.1 PAYLOAD-BOUND PRUNE (413 fix -- see this file's header WIRE
    # CONTRACT note): the old behavior kept every existing CoachBuild set
    # for a DIFFERENT champion+role, so a user who has been in champ select
    # for many champions accumulated one ~10-block CoachBuild set PER
    # champ+role, ALL of which shipped in every subsequent PUT (the endpoint
    # replaces the whole object). v0.43.0's fuller item-set blocks pushed
    # that combined payload past the LCU item-sets size limit -> the LCU
    # returned HTTP 413 (Payload Too Large) and rejected the ENTIRE write,
    # so NONE of the CoachBuild sets landed in-client (both the "413 error"
    # toast AND the "my Tank/Mage category builds aren't in the game"
    # reports are this one rejected PUT).
    #
    # New rule: keep ONLY the sets being written this call ($NewSets --
    # always the CURRENT champion+role, 1-3 sets); drop EVERY pre-existing
    # CoachBuild-titled set (this champion's stale roles AND every other
    # champion's accumulated sets). This bounds OUR contribution to the
    # payload at O(1) -- the current set(s) -- instead of O(champions ever
    # viewed). Cross-champion persistence had near-zero value (you play one
    # champion per game and re-push its build on the next champ-select) and
    # was the entire source of the unbounded growth. Keeping only the
    # current set is strictly safer against 413 than any "keep N recent"
    # cap.
    #
    # HARD INVARIANT (SelfTest-pinned, do NOT weaken): the prune boundary is
    # the LITERAL generic prefix "CoachBuild". A set whose title does NOT
    # start with "CoachBuild" is NEVER dropped -- the user's own hand-made
    # sets pass through byte-for-byte, always. Our own writes are all
    # required to start with "CoachBuild" (Test-ItemSetsPayload enforces it),
    # so this generic boundary cleanly separates "ours, prunable" from
    # "theirs, sacred" without needing the champ-scoped prefix at all.
    #
    # $ReplacePrefix is still accepted + validated upstream (wire back-compat
    # with the web side, which keeps sending champScopedReplacePrefix) but is
    # no longer the prune boundary: the generic "CoachBuild" literal drops a
    # strict superset of what any champ-scoped prefix would, which is exactly
    # the payload-bounding we now want.
    param($ExistingSetsObject, $NewSets, $ReplacePrefix = $null)
    $newArr = @($NewSets)
    $rawExisting = $ExistingSetsObject.itemSets
    $existingArr = if ($rawExisting) { @($rawExisting) } else { @() }
    # Keep every NON-CoachBuild set untouched (the hard invariant); drop
    # every pre-existing CoachBuild set (all of ours are being superseded by
    # $newArr or are stale accumulation). A null/empty title is treated as
    # NOT-ours and kept -- we only ever prune something we can positively
    # identify as a CoachBuild set.
    $kept = @($existingArr | Where-Object { -not ($_.title -and ([string]$_.title).StartsWith('CoachBuild')) })
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
        # v1.5.1: this is the merge-safety GET (the #1 correctness risk per
        # this function's own header comment) -- its own hint, distinct from
        # the current-summoner read-failed above, so a report is
        # unambiguous about which GET actually failed.
        return [pscustomobject]@{ ok = $false; reason = 'read-failed'; hint = "couldn't read your existing item sets -- nothing was changed" }
    }
    $merged = Merge-ItemSets -ExistingSetsObject $existing.Content -NewSets $Sets -ReplacePrefix $ReplacePrefix
    $put = Invoke-LcuRaw -Method PUT -Path "/lol-item-sets/v1/item-sets/$summonerId/sets" -Body $merged -Port $LcuPort -Token $LcuToken -Scheme $Scheme
    if (-not $put.Ok) {
        return [pscustomobject]@{ ok = $false; reason = 'write-failed'; hint = (Get-LcuFailureHint -StatusCode $put.StatusCode -Action 'item-set write') }
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

function Get-DraftDeepLinkUrl {
    # v1.6.0 -- /draft has no championId/role param: it's a read-only live
    # SYNC surface (draftLiveSync.ts resolves lane/enemies/hover off the
    # SAME champSelect snapshot the bridge already serves via /status), not
    # a per-champion deep link like Get-DeepLinkUrl above. Only `session` is
    # needed, so /draft's own mount effect can adopt it (companionClient.ts
    # setSession) the same way the Builds page's does.
    param([string]$AppOrigin, [string]$SessionToken)
    return "$AppOrigin/draft?session=$SessionToken"
}

function Get-PrewarmBuildsUrl {
    # v1.7.0 -- the Builds URL for the champ-select ENTRY pre-warm, before any
    # champion has resolved. Session-only, deliberately WITHOUT championId/role:
    # there is nothing to deep-link to yet, and inventing a placeholder id would
    # make the page render a champion the user never hovered. The tab adopts the
    # session (app/page.tsx's mount effect takes a session-only link since
    # v0.59.0; a previously-paired browser also rehydrates it from localStorage)
    # and then live-follows the first hover IN PLACE via its own /status poll --
    # champSelectFollow.ts works for any tab holding a session, deep-linked or
    # not. Same shape as Get-DraftDeepLinkUrl, and for the same reason.
    param([string]$AppOrigin, [string]$SessionToken)
    return "$AppOrigin/?session=$SessionToken"
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

# v1.6.4 (tab-spam fix). Two tunables, deliberately named rather than inline:
#
# AttachWindowSeconds -- how recently a follow-capable page must have polled
#   for it to count as attached. Was an inline 8, justified against the web
#   poll's ~3s cadence. That justification only holds for a FOREGROUND tab:
#   this feature is used precisely while the tab is backgrounded behind a
#   fullscreen game, where Chrome's intensive throttling drops hidden-tab
#   timers to roughly once per MINUTE after 5 minutes hidden. 8s could not
#   survive that, so every champ-select re-opened both tabs and they piled up
#   (live-reported 2026-07-25, screenshot: 4 stacked tabs). 150s clears a
#   60s throttled cadence with room for jitter.
#
# OpenGraceSeconds -- a tab that was JUST opened has not had time to load,
#   boot React and send its first follow poll (browser cold start is
#   seconds). Without this, a champion change inside that gap sees "not
#   attached" and opens a SECOND pair -- the open->attach race, which is how
#   one champ-select alone could produce 4 tabs. Treat a just-opened kind as
#   attached until it has had a fair chance to answer; if it never does (the
#   open genuinely failed), the grace lapses and the next champion change
#   opens again.
#
# Neither tunable can tell "backgrounded and throttled" apart from "closed" on
# its own -- that ambiguity IS the v1.7.0 bug (a closed browser kept looking
# attached for up to AttachWindowSeconds, so a whole champ-select could pass
# with nothing opening). The two v1.7.0 additions below resolve it with real
# signal instead of a shorter timeout: an EXPLICIT detach from the page, and a
# browser-process liveness check for when no detach could be sent.
$script:AttachWindowSeconds = 150
$script:OpenGraceSeconds = 25
$script:LastTabOpenAt = @{ builds = $null; draft = $null }

# v1.7.0 -- process names checked by Test-BrowserProcessRunning. A miss here
# costs at most ONE extra tab open (the guard only ever widens opening), so the
# list is deliberately common-case rather than exhaustive, and the user's actual
# default browser is resolved from the registry on top of it.
$script:KnownBrowserProcessNames = @(
    'chrome', 'msedge', 'firefox', 'brave', 'opera', 'opera_gx', 'vivaldi',
    'chromium', 'thorium', 'librewolf', 'waterfox', 'floorp', 'arc', 'zen', 'iexplore'
)
# Test seam: $null = really probe. -Mock/-SelfTest set $true so the existing
# attach-gate cases keep asserting the follow-stamp logic on a machine with no
# browser running, and the dedicated liveness cases flip it to $false.
$script:BrowserProbeOverride = $null

function Reset-TabOpenGrace {
    # Called on champ-select ENTRY alongside Reset-ChampSelectState: a grace
    # left over from a previous game must never suppress the first open of a
    # new one.
    $script:LastTabOpenAt = @{ builds = $null; draft = $null }
}

function Get-DefaultBrowserProcessName {
    # HKCU UrlAssociations\https\UserChoice -> ProgId -> HKCR shell\open\command
    # -> the exe basename. Best-effort: every failure mode (no key, a ProgId with
    # no command, a command line this regex doesn't recognise) returns $null and
    # leaves Test-BrowserProcessRunning on the known-names list alone.
    try {
        $progId = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction Stop).ProgId
        if (-not $progId) { return $null }
        $cmd = (Get-ItemProperty -Path "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command" -ErrorAction Stop).'(default)'
        if (-not $cmd) { return $null }
        if ($cmd -match '([^\\/"]+)\.exe') { return $matches[1] }
    } catch {}
    return $null
}

function Test-BrowserProcessRunning {
    # v1.7.0 hard-kill fallback. `pagehide` covers a closed tab/window and an
    # orderly browser exit; it does NOT fire on a task-kill, a crash, or a
    # sign-out. Without this, those cases keep a stale attach stamp alive for
    # the full AttachWindowSeconds and suppress the open the user is waiting
    # for. Only ever used to make an attached kind count as DETACHED, never the
    # other way round -- so a false negative costs one redundant tab, and it
    # cannot resurrect the v1.6.4 tab-spam bug (which required suppression to
    # fail while a browser WAS running, where this returns $true and is inert).
    # Called only on champ-select entry and on a champion CHANGE, so the process
    # enumeration is rare -- not a per-tick cost.
    if ($null -ne $script:BrowserProbeOverride) { return [bool]$script:BrowserProbeOverride }
    $names = @($script:KnownBrowserProcessNames)
    $default = Get-DefaultBrowserProcessName
    if ($default -and ($names -notcontains $default)) { $names += $default }
    try {
        return @(Get-Process -Name $names -ErrorAction SilentlyContinue).Count -gt 0
    } catch {
        # Never let a process-enumeration failure decide anything: fall back to
        # the pre-v1.7.0 behaviour (trust the stamp).
        return $true
    }
}

function Get-TabDetachAt {
    # The bridge runspace records detaches as ISO-8601 UTC strings in $Sync;
    # parsed here to a LOCAL DateTime, matching Test-CompanionHasAttachedTab's
    # existing `[datetime]$ts` vs `Get-Date` convention. $null when no detach has
    # ever been recorded for this kind (including on the mock bridge, whose
    # hashtable simply has no such key).
    param([ValidateSet('builds', 'draft')][string]$Kind)
    if (-not $script:Bridge -or -not $script:Bridge.Sync) { return $null }
    $raw = if ($Kind -eq 'draft') { $script:Bridge.Sync.LastDraftDetachAt } else { $script:Bridge.Sync.LastBuildsDetachAt }
    if (-not $raw) { return $null }
    try { return [datetime]$raw } catch { return $null }
}

function Set-TabOpenedNow {
    param([ValidateSet('builds', 'draft')][string]$Kind)
    if (-not $script:LastTabOpenAt) { Reset-TabOpenGrace }
    $script:LastTabOpenAt[$Kind] = Get-Date
}

function Test-TabOpenGraceActive {
    param([ValidateSet('builds', 'draft')][string]$Kind)
    if (-not $script:LastTabOpenAt) { return $false }
    $at = $script:LastTabOpenAt[$Kind]
    if (-not $at) { return $false }
    # v1.7.0: an explicit detach AFTER the open ends the grace immediately. The
    # grace exists to cover a tab that hasn't answered YET; a detach is the tab
    # answering "I'm gone", so there is nothing left to wait for. Without this,
    # opening a tab and closing it inside the 25s window left the kind
    # suppressed for the rest of that window.
    $detachAt = Get-TabDetachAt -Kind $Kind
    if ($detachAt -and $detachAt -gt $at) { return $false }
    return ((Get-Date) - $at).TotalSeconds -lt $script:OpenGraceSeconds
}

function Test-CompanionHasAttachedTab {
    # v1.3.0 (attached-tab live-follow), NARROWED in v1.5.0 to follow-capable
    # pollers only, split PER-KIND in v1.6.0 ("two pages simultaneously"
    # ship): a "tab is attached" means a specific follow-capable PAGE (Builds
    # or /draft) has polled /status recently, not merely any page, and not
    # merely "some follow-capable page" either -- Builds and /draft are now
    # opened/suppressed INDEPENDENTLY, so a /draft tab attached must never
    # suppress opening Builds, and vice versa. Every route in the app polls
    # /status once a session token exists (CompanionProvider is mounted
    # app-wide, app/layout.tsx), but only Builds (`/`) and `/draft`
    # themselves react to a live champ-select change -- a poll from
    # /live-setup, /mystats, /history, or /movers proves nothing is
    # listening, so it must NOT suppress either open.
    #
    # companionClient's follow-capable poll appends `follow=builds` or
    # `follow=draft` to its /status query string (v1.5.0's boolean
    # `follow=1` widened to page identity); the bridge handler stamps that
    # into $Sync.LastBuildsFollowAt / $Sync.LastDraftFollowAt respectively
    # (LastStatusPollAt keeps stamping on EVERY /status poll regardless of
    # follow, for other diagnostics). A legacy `follow=1` (stale cached
    # pre-1.6.0 web build) stamps LastBuildsFollowAt only -- see the bridge
    # handler's own comment for why that's the safe degrade (at minimum keep
    # suppressing the Builds open users already had; /draft simply behaves
    # as though no tab is ever attached for an old web build, same as
    # pre-1.3.0 companion behavior).
    #
    # 8s window: generous versus the web poll's own ~3s cadence, tight
    # enough that a genuinely closed tab (no follow poll in 8s) still gets a
    # fresh Start-Process on the next hover.
    #
    # Back-compat: a companion running this code against a STALE cached web
    # build that never sends ANY follow param (pre-1.5.0 client) will never
    # see either field set at all -- both stay $null forever, so this always
    # returns $false for both kinds and every champ-select change opens
    # BOTH pages fresh, same as the pre-1.3.0 behavior. That's the
    # deliberate degrade: correctness (always opens) over the live-follow
    # optimization (skip redundant opens) when the two sides disagree on the
    # contract.
    param([ValidateSet('builds', 'draft')][string]$Kind)
    # Open->attach race guard (v1.6.4): checked BEFORE the bridge state so it
    # still holds on the very first open of a launch, when the follow field is
    # legitimately still $null and the tab is mid-cold-start.
    if (Test-TabOpenGraceActive -Kind $Kind) { return $true }
    if (-not $script:Bridge -or -not $script:Bridge.Sync) { return $false }
    $ts = if ($Kind -eq 'draft') { $script:Bridge.Sync.LastDraftFollowAt } else { $script:Bridge.Sync.LastBuildsFollowAt }
    if (-not $ts) { return $false }
    # v1.7.0 hard-kill fallback -- see Test-BrowserProcessRunning. Checked AFTER
    # the grace deliberately: a browser launched microseconds ago may not have a
    # process yet, and voiding the grace on that would re-open a second pair,
    # which is precisely the race the grace exists to prevent.
    if (-not (Test-BrowserProcessRunning)) { return $false }
    try {
        return (New-TimeSpan -Start ([datetime]$ts) -End (Get-Date)).TotalSeconds -lt $script:AttachWindowSeconds
    } catch {
        return $false
    }
}

function Invoke-ChampSelectPrewarm {
    # v1.7.0 -- "have the pages ready" (live-reported 2026-07-26: with the
    # browser closed, nothing opened at all for a whole champ-select).
    #
    # Runs ONCE on champ-select ENTRY, before any champion has resolved, and
    # opens whichever of {Builds, /draft} is currently missing -- same per-kind
    # decision (Test-CompanionHasAttachedTab), same Builds-then-/draft order and
    # therefore the same best-effort focus outcome as Update-ChampSelectState's
    # own opens. The point is TIMING, not new behaviour: a cold browser now
    # boots during bans instead of at the first hover, so the pages are loaded
    # and attached by the time the user picks.
    #
    # Interaction with Update-ChampSelectState (deliberate, no double-open):
    # each open here stamps the open->attach grace, so the first champion
    # resolution inside the next OpenGraceSeconds sees both kinds "attached" and
    # opens nothing -- it just advances the debounce, and the pre-warmed tab
    # picks the champion up in place via its own live-follow poll. A resolution
    # AFTER the grace lapses sees the real follow stamps those tabs have been
    # sending for ~25s, which is the same suppression by a different route. If
    # the pre-warmed tab never polls (session never paired on this browser
    # profile, open genuinely failed), both fall through and the champion change
    # opens a proper deep link -- the pre-v1.7.0 behaviour, never worse.
    param([string]$AppOrigin, [string]$SessionToken)
    $hasBuilds = Test-CompanionHasAttachedTab -Kind builds
    $hasDraft = Test-CompanionHasAttachedTab -Kind draft
    if ($hasBuilds -and $hasDraft) { return }
    if (-not $hasBuilds) {
        Open-CompanionUrl -Url (Get-PrewarmBuildsUrl -AppOrigin $AppOrigin -SessionToken $SessionToken)
        Set-TabOpenedNow -Kind builds
    }
    if (-not $hasDraft) {
        Open-CompanionUrl -Url (Get-DraftDeepLinkUrl -AppOrigin $AppOrigin -SessionToken $SessionToken)
        Set-TabOpenedNow -Kind draft
    }
    Write-CompanionLog "champ-select entry prewarm builds=$(if ($hasBuilds) { 'attached' } else { 'opened' }) draft=$(if ($hasDraft) { 'attached' } else { 'opened' })"
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

    # v1.3.0 (attached-tab live-follow), split into TWO independent pages in
    # v1.6.0 ("two pages simultaneously" ship, user directive 2026-07-22):
    # open only whichever of {Builds, /draft} is currently MISSING, in that
    # exact order (Builds first, /draft last -- Start-Process order is
    # best-effort OS focus order, so /draft lands focused when both are
    # opened together, per the directive). Debounce state above still
    # advances regardless of which/whether opens happen (so we don't
    # re-decide on every tick for the same champion) -- champion CHANGES
    # mid-select keep exactly this semantics: opens only happen when the
    # debounce admits a NEW champion resolution (this code path), never on a
    # per-tick timer; an attached tab that's missing here stays missing
    # until the NEXT champion change, it is not retro-opened mid-select.
    #
    # Decision table (hasBuilds / hasDraft from Test-CompanionHasAttachedTab):
    #   neither attached -> open Builds, then open /draft (both; draft focus)
    #   only draft attached -> open Builds only
    #   only Builds attached -> open /draft only (this focuses the NEW
    #     /draft tab instead -- unavoidable from Start-Process; the "draft
    #     as main focus" preference is specifically about the both-missing
    #     case above)
    #   both attached -> no opens (both already live-follow via their own
    #     polls, exactly like the pre-1.6.0 single-page behavior)
    $hasBuilds = Test-CompanionHasAttachedTab -Kind builds
    $hasDraft = Test-CompanionHasAttachedTab -Kind draft
    if (-not $hasBuilds) {
        $url = Get-DeepLinkUrl -AppOrigin $AppOrigin -SessionToken $SessionToken -ChampionId $champId -RoleId $roleId
        Open-CompanionUrl -Url $url
        Set-TabOpenedNow -Kind builds
    }
    if (-not $hasDraft) {
        $draftUrl = Get-DraftDeepLinkUrl -AppOrigin $AppOrigin -SessionToken $SessionToken
        Open-CompanionUrl -Url $draftUrl
        Set-TabOpenedNow -Kind draft
    }
    Set-LastOpen -ChampionId $champId -RoleId $roleId
    Write-CompanionLog "champ-select champ=$champId role=$(if ($null -ne $roleId) { $roleId } else { 'none' }) builds=$(if ($hasBuilds) { 'attached' } else { 'opened' }) draft=$(if ($hasDraft) { 'attached' } else { 'opened' })"
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
        if (-not $script:WasChampSelect) {
            Reset-ChampSelectState -State $script:ChampSelectState
            Reset-TabOpenGrace
            # v1.7.0 -- open the pages NOW, not at the first hover, so a cold
            # browser is loaded and attached before the user picks. Ordered
            # after Reset-TabOpenGrace so the previous game's grace can never
            # suppress this entry's opens.
            Invoke-ChampSelectPrewarm -AppOrigin $script:Config.AppOrigin -SessionToken $script:Config.Session
        }
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
            # above by the time this branch runs) -- kept as a general
            # "something polled recently" diagnostic other consumers may
            # still read. v1.5.0: this alone no longer means a tab will
            # live-follow a champ-select change -- see LastBuildsFollowAt/
            # LastDraftFollowAt below and Test-CompanionHasAttachedTab's
            # header comment.
            $Sync.LastStatusPollAt = (Get-Date).ToUniversalTime().ToString('o')
            # v1.5.0: only stamped when the poller declares itself
            # follow-capable (sent by CompanionProvider only on `/` and
            # `/draft` -- see companionClient.ts/CompanionProvider.tsx).
            # v1.6.0 ("two pages simultaneously" ship): the boolean
            # `follow=1` widened to page IDENTITY, `follow=builds` or
            # `follow=draft` -- stamps the matching per-kind field, which is
            # what Test-CompanionHasAttachedTab -Kind actually gates on now.
            # A legacy `follow=1` (stale cached pre-1.6.0 web build) stamps
            # LastBuildsFollowAt -- the safe degrade: it can only ever have
            # meant the single pre-1.6.0 Builds tab, so it must keep
            # suppressing at least that open, never a /draft one it was
            # never capable of signaling for (never tab-spam a legacy
            # client that's already open and polling).
            # v1.7.0: `&detach=1` alongside `follow=<kind>` is the page saying
            # "I am going away" -- sent on pagehide and when a client-side nav
            # leaves a follow-capable route (CompanionProvider.tsx). It CLEARS
            # that kind's attach stamp rather than refreshing it, and records
            # when, so Test-TabOpenGraceActive can also void an open->attach
            # grace the tab has already answered. This is the fix for "browser
            # closed, so nothing opens": without it the last poll before the
            # close kept the kind looking attached for the whole
            # AttachWindowSeconds (150s), which is most of a champ-select.
            # A detach carrying no follow kind touches nothing -- same
            # "prove which page you are" rule as the stamping path.
            $follow = $req.QueryString['follow']
            $detach = $req.QueryString['detach']
            if ($detach -eq '1') {
                if ($follow -eq 'builds' -or $follow -eq '1') {
                    $Sync.LastBuildsFollowAt = $null
                    $Sync.LastBuildsDetachAt = (Get-Date).ToUniversalTime().ToString('o')
                } elseif ($follow -eq 'draft') {
                    $Sync.LastDraftFollowAt = $null
                    $Sync.LastDraftDetachAt = (Get-Date).ToUniversalTime().ToString('o')
                }
            } elseif ($follow -eq 'builds' -or $follow -eq '1') {
                $Sync.LastBuildsFollowAt = (Get-Date).ToUniversalTime().ToString('o')
            } elseif ($follow -eq 'draft') {
                $Sync.LastDraftFollowAt = (Get-Date).ToUniversalTime().ToString('o')
            }
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
                Write-JsonResponse -Response $res -StatusCode 200 -Obj @{ ok = $false; reason = 'no-client'; hint = 'League client not detected -- open the client and try again' }
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
                Write-JsonResponse -Response $res -StatusCode 200 -Obj @{ ok = $false; reason = 'no-client'; hint = 'League client not detected -- open the client and try again' }
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
        LastBuildsFollowAt  = $null
        LastDraftFollowAt   = $null
        LastBuildsDetachAt  = $null
        LastDraftDetachAt   = $null
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
function Get-CompanionLaunchCommand {
    # The single "start a hidden companion watcher" command string, shared by
    # the .vbs autostart launcher AND the -Install immediate-launch path
    # (v1.6.3) so both run byte-identical work: re-download this script and run
    # it with no args (-> Start-Companion, the tray watcher). 100% ASCII.
    param([string]$AppOrigin)
    return 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm ' + $AppOrigin + '/companion.ps1 | iex"'
}

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

function Test-CompanionAlreadyRunning {
    # Cheap, race-tolerant pre-check for the -Install immediate-launch guard
    # (v1.6.3): a running companion holds the named mutex
    # 'Local\CoachBuildCompanion' (Start-Companion -> Test-SingleInstance).
    # OpenExisting SUCCEEDS -> an instance is live; it throws
    # WaitHandleCannotBeOpenedException when nothing holds the name -> not
    # running. Any other error -> treat as "not running" and let the spawned
    # instance's OWN Test-SingleInstance be the hard backstop (this pre-check
    # only avoids the noise of a doomed second launch; it is never the sole
    # guarantee). The -Install process itself never holds this mutex (it runs
    # Install-Companion, not Start-Companion), so there's no self-false-positive.
    try {
        $m = [System.Threading.Mutex]::OpenExisting('Local\CoachBuildCompanion')
        $m.Dispose()
        return $true
    } catch [System.Threading.WaitHandleCannotBeOpenedException] {
        return $false
    } catch {
        return $false
    }
}

function Start-CompanionDetachedHidden {
    # v1.6.3: launch the companion watcher RIGHT NOW, truly hidden, the exact
    # same way the .vbs launcher does at startup -- WScript.Shell.Run(cmd, 0,
    # False): windowStyle 0 = hidden (honored even when Windows Terminal is the
    # default terminal, unlike -WindowStyle Hidden -- see New-CompanionAutostartVbs),
    # bWaitOnReturn False = fire-and-forget so -Install returns immediately.
    # The spawned process re-downloads this script and runs it with no args ->
    # Start-Companion (tray watcher), which claims the single-instance mutex.
    param([string]$AppOrigin)
    $cmd = Get-CompanionLaunchCommand -AppOrigin $AppOrigin
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Run($cmd, 0, $false)
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

    # Persist the session token FIRST so BOTH the immediately-launched
    # companion (below) and the pairing page resolve the SAME durable token
    # (Get-OrCreateSessionToken is idempotent + file-backed).
    $token = Get-OrCreateSessionToken

    # v1.6.3 (user request): -Install now LAUNCHES the companion immediately so
    # the user doesn't have to click the Startup entry or reboot to actually
    # start it. Double-launch guard: if an instance is already running, surface
    # that and DON'T stack a second (the spawned instance's own single-instance
    # mutex is the hard backstop regardless, so re-running -Install is always
    # idempotent).
    if (Test-CompanionAlreadyRunning) {
        Write-Host 'CoachBuild companion is already running -- not starting a second instance.'
    } else {
        try {
            Start-CompanionDetachedHidden -AppOrigin $script:Config.AppOrigin
            Write-Host 'Started the CoachBuild companion (running hidden in the background).'
        } catch {
            Write-Host "Could not auto-start the companion now ($($_.Exception.Message)); it will start on next sign-in."
        }
    }

    # Install -> pair is one flow: open the pairing page immediately with the
    # durable session token, so Test Connection works right away instead of
    # waiting for the first champ select.
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
        } elseif ($path -like '/lol-perks/v1/pages/*' -and $method -eq 'PUT') {
            # v1.6.2: edit-in-place. Overwrites the matching page's contents
            # (name/styles/selectedPerkIds) while KEEPING its id -- exactly
            # what PUT /lol-perks/v1/pages/{id} does in the live LCU. Preserves
            # the entry's `current` flag so a subsequent GET /currentpage
            # readback sees the freshly-edited content on the still-selected
            # page. PagePutShouldFail simulates the LCU rejecting the edit.
            if ($Sync.PagePutShouldFail) {
                Write-JsonResponse -Response $res -StatusCode 400 -Obj @{ error = 'mock-edit-failed' }
            } else {
                $editId = $path -replace '.*/pages/', ''
                $reader5 = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
                $putBodyRaw = $reader5.ReadToEnd()
                $reader5.Close()
                $putBodyObj = $putBodyRaw | ConvertFrom-Json
                $Sync.MockPages = @(@($Sync.MockPages) | ForEach-Object {
                    if ([string]$_.id -eq [string]$editId) {
                        [pscustomobject]@{
                            id              = $_.id
                            name            = $putBodyObj.name
                            primaryStyleId  = $putBodyObj.primaryStyleId
                            subStyleId      = $putBodyObj.subStyleId
                            selectedPerkIds = $putBodyObj.selectedPerkIds
                            isDeletable     = $true
                            isEditable      = $true
                            current         = $_.current
                        }
                    } else { $_ }
                })
                Write-JsonResponse -Response $res -StatusCode 200 -Obj @{ id = $editId }
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
            if ($Sync.ItemSetsPutShouldFail) {
                # v1.5.1: exercises Invoke-ApplyItemSets's write-failed hint
                # path (Get-LcuFailureHint) end to end -- previously
                # untested, this branch always succeeded before.
                Write-JsonResponse -Response $res -StatusCode 500 -Obj @{ error = 'mock-itemsets-put-failed' }
            } else {
                $reader2 = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
                $putBodyRaw = $reader2.ReadToEnd()
                $reader2.Close()
                $Sync.LastPutBody = $putBodyRaw
                $res.StatusCode = 200
                $res.OutputStream.Close()
            }
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
        ItemSetsPutShouldFail     = $false
        ExistingItemSets          = [pscustomobject]@{ accountId = 1; timestamp = 0; itemSets = @() }
        LastPutBody               = $null
        # Rune-pages mock state (v1.3.0 safety redesign + PUT-currentpage fix)
        MockPages                 = @()
        MockNextPageId            = 20000
        MockCurrentPageId         = $null
        MockInventory             = $null
        CurrentPageSelectShouldFail = $false
        PagePostShouldFail        = $false
        PagePutShouldFail         = $false
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

    # 4c. v1.6.0 -- real HTTP round trip through the actual bridge worker's
    # query-string parsing for `follow=<kind>` (Update-ChampSelectState's own
    # open-decision logic is exercised via -Mock instead, against a fake
    # Sync -- this is specifically the wire-level parsing the bridge worker
    # script block does inline). Covers: follow=builds and follow=draft each
    # stamp only their own field; a request with no follow param stamps
    # neither; legacy follow=1 (stale pre-1.6.0 cached web build) stamps
    # LastBuildsFollowAt only, never LastDraftFollowAt.
    $bridge.Sync.LastBuildsFollowAt = $null
    $bridge.Sync.LastDraftFollowAt = $null
    try {
        [void](Invoke-WebRequest -Uri "$base/status?session=$session&follow=builds" -Method GET -Headers @{ Origin = $appOrigin } -UseBasicParsing)
        if (-not $bridge.Sync.LastBuildsFollowAt) { $failures.Add('follow=builds did not stamp LastBuildsFollowAt') }
        if ($bridge.Sync.LastDraftFollowAt) { $failures.Add('follow=builds incorrectly stamped LastDraftFollowAt') }
    } catch { $failures.Add("follow=builds request threw: $($_.Exception.Message)") }

    $bridge.Sync.LastBuildsFollowAt = $null
    $bridge.Sync.LastDraftFollowAt = $null
    try {
        [void](Invoke-WebRequest -Uri "$base/status?session=$session&follow=draft" -Method GET -Headers @{ Origin = $appOrigin } -UseBasicParsing)
        if (-not $bridge.Sync.LastDraftFollowAt) { $failures.Add('follow=draft did not stamp LastDraftFollowAt') }
        if ($bridge.Sync.LastBuildsFollowAt) { $failures.Add('follow=draft incorrectly stamped LastBuildsFollowAt') }
    } catch { $failures.Add("follow=draft request threw: $($_.Exception.Message)") }

    $bridge.Sync.LastBuildsFollowAt = $null
    $bridge.Sync.LastDraftFollowAt = $null
    try {
        [void](Invoke-WebRequest -Uri "$base/status?session=$session" -Method GET -Headers @{ Origin = $appOrigin } -UseBasicParsing)
        if ($bridge.Sync.LastBuildsFollowAt -or $bridge.Sync.LastDraftFollowAt) { $failures.Add('a /status poll with no follow param incorrectly stamped a follow field') }
    } catch { $failures.Add("no-follow /status request threw: $($_.Exception.Message)") }

    $bridge.Sync.LastBuildsFollowAt = $null
    $bridge.Sync.LastDraftFollowAt = $null
    try {
        [void](Invoke-WebRequest -Uri "$base/status?session=$session&follow=1" -Method GET -Headers @{ Origin = $appOrigin } -UseBasicParsing)
        if (-not $bridge.Sync.LastBuildsFollowAt) { $failures.Add('legacy follow=1 did not stamp LastBuildsFollowAt (back-compat degrade broken)') }
        if ($bridge.Sync.LastDraftFollowAt) { $failures.Add('legacy follow=1 incorrectly stamped LastDraftFollowAt') }
    } catch { $failures.Add("legacy follow=1 request threw: $($_.Exception.Message)") }
    $bridge.Sync.LastBuildsFollowAt = $null
    $bridge.Sync.LastDraftFollowAt = $null

    # 4e. v1.7.0 DETACH beacon (`follow=<kind>&detach=1`, sent by the page on
    # pagehide / on navigating away from a follow-capable route). Must CLEAR
    # that kind's attach stamp, record LastXDetachAt, and leave the OTHER kind
    # entirely alone -- a Builds tab closing must never make /draft re-open.
    # This is the fix for the live-reported "browser closed, so the pages never
    # opened for the whole champ-select".
    $now = (Get-Date).ToUniversalTime().ToString('o')
    $bridge.Sync.LastBuildsFollowAt = $now
    $bridge.Sync.LastDraftFollowAt = $now
    $bridge.Sync.LastBuildsDetachAt = $null
    $bridge.Sync.LastDraftDetachAt = $null
    try {
        [void](Invoke-WebRequest -Uri "$base/status?session=$session&follow=builds&detach=1" -Method GET -Headers @{ Origin = $appOrigin } -UseBasicParsing)
        if ($bridge.Sync.LastBuildsFollowAt) { $failures.Add('detach=1 follow=builds did not CLEAR LastBuildsFollowAt') }
        if (-not $bridge.Sync.LastBuildsDetachAt) { $failures.Add('detach=1 follow=builds did not record LastBuildsDetachAt') }
        if (-not $bridge.Sync.LastDraftFollowAt) { $failures.Add('detach=1 follow=builds wrongly cleared the DRAFT attach stamp') }
        if ($bridge.Sync.LastDraftDetachAt) { $failures.Add('detach=1 follow=builds wrongly recorded LastDraftDetachAt') }
    } catch { $failures.Add("detach=1 follow=builds request threw: $($_.Exception.Message)") }

    $bridge.Sync.LastBuildsFollowAt = $now
    $bridge.Sync.LastDraftFollowAt = $now
    $bridge.Sync.LastBuildsDetachAt = $null
    $bridge.Sync.LastDraftDetachAt = $null
    try {
        [void](Invoke-WebRequest -Uri "$base/status?session=$session&follow=draft&detach=1" -Method GET -Headers @{ Origin = $appOrigin } -UseBasicParsing)
        if ($bridge.Sync.LastDraftFollowAt) { $failures.Add('detach=1 follow=draft did not CLEAR LastDraftFollowAt') }
        if (-not $bridge.Sync.LastDraftDetachAt) { $failures.Add('detach=1 follow=draft did not record LastDraftDetachAt') }
        if (-not $bridge.Sync.LastBuildsFollowAt) { $failures.Add('detach=1 follow=draft wrongly cleared the BUILDS attach stamp') }
        if ($bridge.Sync.LastBuildsDetachAt) { $failures.Add('detach=1 follow=draft wrongly recorded LastBuildsDetachAt') }
    } catch { $failures.Add("detach=1 follow=draft request threw: $($_.Exception.Message)") }

    # A detach that doesn't say WHICH page it is proves nothing -- same rule as
    # the stamping path, so it must touch neither kind.
    $bridge.Sync.LastBuildsFollowAt = $now
    $bridge.Sync.LastDraftFollowAt = $now
    $bridge.Sync.LastBuildsDetachAt = $null
    $bridge.Sync.LastDraftDetachAt = $null
    try {
        [void](Invoke-WebRequest -Uri "$base/status?session=$session&detach=1" -Method GET -Headers @{ Origin = $appOrigin } -UseBasicParsing)
        if (-not $bridge.Sync.LastBuildsFollowAt -or -not $bridge.Sync.LastDraftFollowAt) { $failures.Add('a kind-less detach=1 wrongly cleared an attach stamp') }
        if ($bridge.Sync.LastBuildsDetachAt -or $bridge.Sync.LastDraftDetachAt) { $failures.Add('a kind-less detach=1 wrongly recorded a detach timestamp') }
    } catch { $failures.Add("kind-less detach=1 request threw: $($_.Exception.Message)") }
    $bridge.Sync.LastBuildsFollowAt = $null
    $bridge.Sync.LastDraftFollowAt = $null
    $bridge.Sync.LastBuildsDetachAt = $null
    $bridge.Sync.LastDraftDetachAt = $null

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

    # 6. apply-runes: existing SELECTED CoachBuild page -> EDIT IN PLACE
    # (v1.6.2 root-cause fix, the live user bug). The prior flow DELETEd this
    # page then POSTed a fresh one -- which failed at the DELETE precisely
    # BECAUSE the page was the currently-selected one (the LCU refuses to
    # delete the selected page -> delete-failed -> nothing applied). New
    # behavior: PUT /lol-perks/v1/pages/{id} overwrites OUR OWN page's
    # contents while keeping its id, issuing ZERO deletes; the page stays
    # selected; the readback verifies the new perks; and the non-CoachBuild
    # page is left byte-for-byte untouched (zero-foreign-mutation).
    $newPerks = @(8005, 9111, 9104, 8014, 8017, 8009, 8017, 5008, 5008)
    $mockLcu.Sync.MockPages = @(
        [pscustomobject]@{ id = 111; name = 'My Custom Build'; isDeletable = $true; selectedPerkIds = @(1, 1, 1, 1, 1, 1, 1, 1, 1) }
        [pscustomobject]@{ id = 222; name = 'CoachBuild Test Mid'; isDeletable = $true; selectedPerkIds = @(0, 0, 0, 0, 0, 0, 0, 0, 0) }
    )
    $mockLcu.Sync.MockCurrentPageId = 222
    $mockLcu.Sync.MockCurrentPageOverride = $null
    $mockLcu.Sync.PagePutShouldFail = $false
    $mockLcu.Sync.CurrentPageSelectShouldFail = $false
    $mockLcu.Sync.Calls.Clear()
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($applyBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok -or $obj.selected -ne $true -or $obj.verified -ne $true) {
            $failures.Add("apply-runes in-place edit expected ok/selected/verified all true, got $($r.Content)")
        }
        if (@($mockLcu.Sync.Calls) -contains 'DELETE') {
            $failures.Add('apply-runes in-place edit issued a DELETE -- must edit the selected CoachBuild page in place, never delete it')
        }
        $page222 = @(@($mockLcu.Sync.MockPages) | Where-Object { $_.id -eq 222 })
        if ($page222.Count -ne 1) {
            $failures.Add('apply-runes in-place edit did not keep the CoachBuild page in place (same id 222)')
        } elseif ((@($page222[0].selectedPerkIds) -join ',') -ne ($newPerks -join ',')) {
            $failures.Add("apply-runes in-place edit did not overwrite the page perks in place, got $(@($page222[0].selectedPerkIds) -join ',')")
        }
        if ([string]$mockLcu.Sync.MockCurrentPageId -ne '222') {
            $failures.Add("apply-runes in-place edit lost the selection (currentPageId=$($mockLcu.Sync.MockCurrentPageId), expected 222)")
        }
        $page111 = @(@($mockLcu.Sync.MockPages) | Where-Object { $_.id -eq 111 })
        if ($page111.Count -ne 1 -or ((@($page111[0].selectedPerkIds) -join ',') -ne '1,1,1,1,1,1,1,1,1')) {
            $failures.Add('apply-runes in-place edit touched the non-CoachBuild page (zero-foreign-mutation violated)')
        }
    } catch { $failures.Add("apply-runes in-place edit threw: $($_.Exception.Message)") }

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

    # 6b-PUT. The gap every OTHER adversarial rune case missed: an unownable
    # title that overwrites a user page IN PLACE, issuing ZERO DELETEs. Cases
    # 6b/6c/6i/6j/6k all assert on DELETE, so a PUT-shaped violation walked
    # straight past the whole suite -- which is how Invoke-ApplyRunes shipped
    # for six versions with no title gate at all while the docs claimed one.
    # The fixture puts a page whose title EXACTLY equals the request name in
    # front of it, so a missing guard is guaranteed to hit STEP 2's in-place PUT.
    $mockLcu.Sync.MockPages = @(
        [pscustomobject]@{ id = 1001; name = 'Ranked Page 1'; isDeletable = $true; selectedPerkIds = @(1, 2, 3) }
    )
    $mockLcu.Sync.MockInventory = @{ ownedPageCount = 1 }
    $mockLcu.Sync.MockCurrentPageId = 1001
    $mockLcu.Sync.Calls.Clear()
    $foreignBody = @{ name = 'Ranked Page 1'; primaryStyleId = 8000; subStyleId = 8100; selectedPerkIds = @(8005, 9111, 9104, 8014, 8017, 8009, 8017, 5008, 5008); current = $true; mode = 'auto' }
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($foreignBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if ($obj.ok -ne $false -or $obj.reason -ne 'invalid-page') {
            $failures.Add("apply-runes foreign-title expected ok:false/invalid-page, got $($r.Content)")
        }
        if (@($mockLcu.Sync.Calls) -contains 'PUT') {
            $failures.Add('apply-runes foreign-title issued a PUT -- overwrote a non-CoachBuild page in place, compliance violation')
        }
        if (@($mockLcu.Sync.Calls) -contains 'DELETE') {
            $failures.Add('apply-runes foreign-title issued a DELETE on a non-CoachBuild page -- compliance violation')
        }
        $page1001 = @($mockLcu.Sync.MockPages | Where-Object { $_.id -eq 1001 })
        if (@($page1001[0].selectedPerkIds) -join ',' -ne '1,2,3') {
            $failures.Add("apply-runes foreign-title mutated the user page perks, got $(@($page1001[0].selectedPerkIds) -join ',')")
        }
    } catch { $failures.Add("apply-runes foreign-title threw: $($_.Exception.Message)") }

    # Restore 6b's fixture: 6c below says "SAME adversarial 5-page/full
    # fixture" and inherits it from 6b rather than building its own, so this
    # case must hand it back exactly as it found it.
    $mockLcu.Sync.MockPages = @(1..5 | ForEach-Object { [pscustomobject]@{ id = (1000 + $_); name = "User Page $_"; isDeletable = $true } })
    $mockLcu.Sync.MockInventory = @{ ownedPageCount = 5 }

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

    # 6f. apply-runes edit-failed envelope (v1.6.2 fail-soft) -- existing
    # SELECTED CoachBuild page, the in-place PUT edit is rejected by the LCU.
    # Must fail soft with {reason:'edit-failed'} + a status-coded hint and
    # must NEVER fall back to deleting or POSTing -- the page is still the
    # selected page, so a delete would fail the same way and reintroduce the
    # exact delete-failed bug this ship fixes.
    $mockLcu.Sync.MockPages = @([pscustomobject]@{ id = 555; name = 'CoachBuild Test Mid'; isDeletable = $true; selectedPerkIds = @(0, 0, 0, 0, 0, 0, 0, 0, 0) })
    $mockLcu.Sync.MockCurrentPageId = 555
    $mockLcu.Sync.PagePutShouldFail = $true
    $mockLcu.Sync.Calls.Clear()
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($applyBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if ($obj.ok -ne $false -or $obj.reason -ne 'edit-failed' -or -not $obj.hint) {
            $failures.Add("apply-runes edit-failed envelope wrong: $($r.Content)")
        }
        if (@($mockLcu.Sync.Calls) -contains 'DELETE') { $failures.Add('apply-runes DELETEd after a failed in-place edit (must not fall back to delete)') }
        if (@($mockLcu.Sync.Calls) -contains 'POST') { $failures.Add('apply-runes POSTed after a failed in-place edit (must not fall back to create)') }
        if (@(@($mockLcu.Sync.MockPages) | Where-Object { $_.id -eq 555 }).Count -ne 1) { $failures.Add('apply-runes edit-failed path removed/lost the CoachBuild page') }
    } catch { $failures.Add("apply-runes edit-failed threw: $($_.Exception.Message)") }
    $mockLcu.Sync.PagePutShouldFail = $false
    $mockLcu.Sync.MockPages = @()

    # -- v1.6.3 TWO-PAGE MODEL: WPA "CoachBuild <champ> <role>" and Pro
    # "CoachBuild <champ> <role> Pro" must COEXIST as two separate pages, and a
    # champ change must clean up BOTH old-champ pages while leaving foreign
    # pages untouched. --------------------------------------------------------
    $wpaPerks = @(8005, 9111, 9104, 8014, 8017, 8009, 8017, 5008, 5008)
    $proPerks = @(8010, 8009, 9104, 8014, 8299, 8444, 8453, 5005, 5001)

    # 6g. apply PRO when only the WPA page exists -> creates a SEPARATE
    # "CoachBuild Teemo Top Pro" page, leaves the WPA page byte-for-byte
    # untouched, issues ZERO deletes (both share the champ prefix). This is the
    # core of the revert fix: the two pages coexist instead of one overwriting
    # the other.
    $mockLcu.Sync.MockPages = @([pscustomobject]@{ id = 700; name = 'CoachBuild Teemo Top'; isDeletable = $true; selectedPerkIds = $wpaPerks; current = $true })
    $mockLcu.Sync.MockCurrentPageId = 700
    $mockLcu.Sync.MockInventory = $null
    $mockLcu.Sync.MockNextPageId = 40000
    $mockLcu.Sync.Calls.Clear()
    $proBody = @{ name = 'CoachBuild Teemo Top Pro'; primaryStyleId = 8000; subStyleId = 8100; selectedPerkIds = $proPerks; current = $true; replacePrefix = 'CoachBuild Teemo '; mode = 'manual' }
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($proBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok) { $failures.Add("apply-runes PRO separate-page expected ok:true, got $($r.Content)") }
        if (@($mockLcu.Sync.Calls) -contains 'DELETE') { $failures.Add('apply-runes PRO separate-page issued a DELETE (WPA and Pro share the champ prefix -- neither is stale)') }
        $wpaPage = @(@($mockLcu.Sync.MockPages) | Where-Object { $_.id -eq 700 })
        if ($wpaPage.Count -ne 1 -or ((@($wpaPage[0].selectedPerkIds) -join ',') -ne ($wpaPerks -join ','))) {
            $failures.Add('apply-runes PRO separate-page mutated the WPA page (must leave "CoachBuild Teemo Top" untouched)')
        }
        $proPage = @(@($mockLcu.Sync.MockPages) | Where-Object { $_.name -eq 'CoachBuild Teemo Top Pro' })
        if ($proPage.Count -ne 1 -or ((@($proPage[0].selectedPerkIds) -join ',') -ne ($proPerks -join ','))) {
            $failures.Add("apply-runes PRO separate-page did not create the distinct Pro page with pro perks, pages=$((@($mockLcu.Sync.MockPages) | ForEach-Object { $_.name }) -join '|')")
        }
        if (@($mockLcu.Sync.MockPages).Count -ne 2) { $failures.Add("apply-runes PRO separate-page expected 2 coexisting pages, got $(@($mockLcu.Sync.MockPages).Count)") }
    } catch { $failures.Add("apply-runes PRO separate-page threw: $($_.Exception.Message)") }

    # 6h. with BOTH pages present, applying WPA edits ONLY the exact-title WPA
    # page in place and leaves the Pro page untouched (exact-title match, never
    # a prefix match that would clobber the sibling). Zero deletes.
    $mockLcu.Sync.MockPages = @(
        [pscustomobject]@{ id = 700; name = 'CoachBuild Teemo Top'; isDeletable = $true; selectedPerkIds = @(1, 1, 1, 1, 1, 1, 1, 1, 1); current = $true }
        [pscustomobject]@{ id = 701; name = 'CoachBuild Teemo Top Pro'; isDeletable = $true; selectedPerkIds = $proPerks; current = $false }
    )
    $mockLcu.Sync.MockCurrentPageId = 700
    $mockLcu.Sync.Calls.Clear()
    $wpaBody = @{ name = 'CoachBuild Teemo Top'; primaryStyleId = 8000; subStyleId = 8100; selectedPerkIds = $wpaPerks; current = $true; replacePrefix = 'CoachBuild Teemo '; mode = 'auto' }
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($wpaBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok) { $failures.Add("apply-runes WPA-with-both expected ok:true, got $($r.Content)") }
        if (@($mockLcu.Sync.Calls) -contains 'DELETE') { $failures.Add('apply-runes WPA-with-both issued a DELETE (must edit WPA in place, never delete the Pro page)') }
        $wpaPage = @(@($mockLcu.Sync.MockPages) | Where-Object { $_.id -eq 700 })
        if ($wpaPage.Count -ne 1 -or ((@($wpaPage[0].selectedPerkIds) -join ',') -ne ($wpaPerks -join ','))) {
            $failures.Add('apply-runes WPA-with-both did not overwrite the WPA page in place')
        }
        $proPage = @(@($mockLcu.Sync.MockPages) | Where-Object { $_.id -eq 701 })
        if ($proPage.Count -ne 1 -or ((@($proPage[0].selectedPerkIds) -join ',') -ne ($proPerks -join ','))) {
            $failures.Add('apply-runes WPA-with-both mutated the Pro page (cross-page clobber -- the exact bug this ship prevents)')
        }
    } catch { $failures.Add("apply-runes WPA-with-both threw: $($_.Exception.Message)") }

    # 6i. champ CHANGE: applying for Zed cleans up BOTH stale Teemo pages (WPA +
    # Pro) via the champ-scoped prefix, leaves a foreign non-CoachBuild page
    # untouched, and creates the new champ's page.
    $mockLcu.Sync.MockPages = @(
        [pscustomobject]@{ id = 700; name = 'CoachBuild Teemo Top'; isDeletable = $true; selectedPerkIds = $wpaPerks; current = $false }
        [pscustomobject]@{ id = 701; name = 'CoachBuild Teemo Top Pro'; isDeletable = $true; selectedPerkIds = $proPerks; current = $false }
        [pscustomobject]@{ id = 800; name = 'My Hand-made Page'; isDeletable = $true; selectedPerkIds = @(2, 2, 2, 2, 2, 2, 2, 2, 2); current = $true }
    )
    $mockLcu.Sync.MockCurrentPageId = 800
    $mockLcu.Sync.MockInventory = $null
    $mockLcu.Sync.MockNextPageId = 41000
    $mockLcu.Sync.Calls.Clear()
    $zedBody = @{ name = 'CoachBuild Zed Mid'; primaryStyleId = 8000; subStyleId = 8100; selectedPerkIds = $wpaPerks; current = $true; replacePrefix = 'CoachBuild Zed '; mode = 'manual' }
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($zedBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok) { $failures.Add("apply-runes champ-change expected ok:true, got $($r.Content)") }
        if (@(@($mockLcu.Sync.MockPages) | Where-Object { $_.name -like 'CoachBuild Teemo *' }).Count -ne 0) {
            $failures.Add('apply-runes champ-change did not clean up BOTH stale Teemo pages')
        }
        $foreign = @(@($mockLcu.Sync.MockPages) | Where-Object { $_.id -eq 800 })
        if ($foreign.Count -ne 1 -or ((@($foreign[0].selectedPerkIds) -join ',') -ne '2,2,2,2,2,2,2,2,2')) {
            $failures.Add('apply-runes champ-change touched the foreign non-CoachBuild page (zero-foreign-mutation violated)')
        }
        if (@(@($mockLcu.Sync.MockPages) | Where-Object { $_.name -eq 'CoachBuild Zed Mid' }).Count -ne 1) {
            $failures.Add("apply-runes champ-change did not create the new champ page, pages=$((@($mockLcu.Sync.MockPages) | ForEach-Object { $_.name }) -join '|')")
        }
    } catch { $failures.Add("apply-runes champ-change threw: $($_.Exception.Message)") }

    # 6j. cleanup FAIL-SOFT: a stale foreign-champ page whose delete the LCU
    # refuses (DeleteShouldFail) must NOT abort the apply -- the exact-title
    # edit still lands, and the un-deletable stale page simply survives to
    # self-heal next cycle.
    $mockLcu.Sync.MockPages = @(
        [pscustomobject]@{ id = 700; name = 'CoachBuild Teemo Top'; isDeletable = $true; selectedPerkIds = @(1, 1, 1, 1, 1, 1, 1, 1, 1); current = $true }
        [pscustomobject]@{ id = 900; name = 'CoachBuild Zed Mid'; isDeletable = $true; selectedPerkIds = $proPerks; current = $false }
    )
    $mockLcu.Sync.MockCurrentPageId = 700
    $mockLcu.Sync.MockInventory = $null
    $mockLcu.Sync.DeleteShouldFail = $true
    $mockLcu.Sync.Calls.Clear()
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($wpaBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok -or $obj.selected -ne $true -or $obj.verified -ne $true) {
            $failures.Add("apply-runes cleanup-fail-soft expected ok/selected/verified all true, got $($r.Content)")
        }
        if (@($mockLcu.Sync.Calls) -notcontains 'DELETE') { $failures.Add('apply-runes cleanup-fail-soft never attempted the stale delete') }
        $edited = @(@($mockLcu.Sync.MockPages) | Where-Object { $_.id -eq 700 })
        if ($edited.Count -ne 1 -or ((@($edited[0].selectedPerkIds) -join ',') -ne ($wpaPerks -join ','))) {
            $failures.Add('apply-runes cleanup-fail-soft did not still edit the exact-title page after the failed cleanup delete')
        }
        if (@(@($mockLcu.Sync.MockPages) | Where-Object { $_.id -eq 900 }).Count -ne 1) {
            $failures.Add('apply-runes cleanup-fail-soft lost the un-deletable stale page (delete was supposed to fail soft)')
        }
    } catch { $failures.Add("apply-runes cleanup-fail-soft threw: $($_.Exception.Message)") }
    $mockLcu.Sync.DeleteShouldFail = $false

    # 6k. AUTO mode + replacePrefix present + only FOREIGN pages, inventory full:
    # the champ-scoped cleanup must NEVER delete a non-CoachBuild page (the
    # compliance guarantee still holds with replacePrefix set) -> slots-full,
    # zero deletes, user pages intact.
    $mockLcu.Sync.MockPages = @(1..5 | ForEach-Object { [pscustomobject]@{ id = (1200 + $_); name = "User Page $_"; isDeletable = $true } })
    $mockLcu.Sync.MockInventory = @{ ownedPageCount = 5 }
    $mockLcu.Sync.Calls.Clear()
    $autoPrefixBody = @{ name = 'CoachBuild Zed Mid'; primaryStyleId = 8000; subStyleId = 8100; selectedPerkIds = $wpaPerks; current = $true; replacePrefix = 'CoachBuild Zed '; mode = 'auto' }
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($autoPrefixBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if ($obj.ok -ne $false -or $obj.reason -ne 'slots-full') { $failures.Add("apply-runes AUTO+prefix adversarial expected slots-full, got $($r.Content)") }
        if (@($mockLcu.Sync.Calls) -contains 'DELETE') { $failures.Add('apply-runes AUTO+prefix cleanup deleted a non-CoachBuild page -- compliance violation') }
        if (@($mockLcu.Sync.MockPages).Count -ne 5) { $failures.Add('apply-runes AUTO+prefix adversarial mutated the user pages') }
    } catch { $failures.Add("apply-runes AUTO+prefix adversarial threw: $($_.Exception.Message)") }
    $mockLcu.Sync.MockInventory = $null
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

    # 6f. v1.6.1 -- PAYLOAD-BOUND PRUNE (413 fix, supersedes the v1.3.1
    # champ-scoped semantics this test used to assert): a write now keeps
    # ONLY the set(s) being written and drops EVERY pre-existing CoachBuild
    # set. So a Senna Support write removes the old Senna-Bot titles (as
    # before) AND now ALSO prunes a DIFFERENT champion's stale CoachBuild
    # set (CoachBuild Viktor Mid) to bound the payload -- while STILL never
    # touching a non-CoachBuild (user) set.
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
            # v1.6.1: the DIFFERENT champion's stale CoachBuild set is now
            # PRUNED (payload-bound), not preserved -- the whole point of the
            # 413 fix. Its survival used to be asserted here; now its removal is.
            if ($putTitles -contains 'CoachBuild Viktor Mid') { $failures.Add('apply-itemsets 413-prune did NOT remove a different champion''s stale CoachBuild set') }
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

    # 6i. v1.6.1 -- PAYLOAD-BOUND PRUNE (413 fix): an accumulated pile of 15
    # CoachBuild sets (many different champions+roles) + 3 user sets must,
    # after ONE write of the current champion, collapse to exactly the
    # current CoachBuild set(s) + all 3 user sets preserved byte-for-byte.
    # This is the whole 413 defence: OUR contribution to the PUT is bounded
    # at the current set(s), never O(champions ever viewed). The hard
    # invariant still holds -- zero user (non-CoachBuild) sets removed.
    $userSetsFixture = @(
        [pscustomobject]@{ uid = 'user-a'; title = 'My Poke Build'; type = 'custom'; blocks = @() }
        [pscustomobject]@{ uid = 'user-b'; title = 'ARAM Full AP'; type = 'custom'; blocks = @() }
        [pscustomobject]@{ uid = 'user-c'; title = 'Split Push Set'; type = 'custom'; blocks = @() }
    )
    $accumulatedCoach = @(1..15 | ForEach-Object {
        [pscustomobject]@{ uid = "coachbuild-champ$_-role"; title = "CoachBuild Champ$_ Mid $([char]0x2014) Core"; type = 'custom'; blocks = @() }
    })
    $mockLcu.Sync.ExistingItemSets = [pscustomobject]@{
        accountId = 55555
        timestamp = 1700009999
        itemSets  = @($userSetsFixture + $accumulatedCoach)
    }
    $currentSet = @(
        [pscustomobject]@{ uid = 'coachbuild-viktor-mid'; title = "CoachBuild Viktor Mid $([char]0x2014) Core"; type = 'custom'; map = 'any'; mode = 'any'; associatedMaps = @(); associatedChampions = @(112); preferredItemSlots = @(); sortrank = 0; blocks = @(@{ type = 'Core build'; items = @(@{ id = '3020'; count = 1 }) }) }
    )
    $mockLcu.Sync.LastPutBody = $null
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-itemsets?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes((@{ championId = 112; sets = $currentSet; replacePrefix = 'CoachBuild Viktor ' } | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if (-not $obj.ok -or $obj.count -ne 1) { $failures.Add("apply-itemsets 413-prune expected ok:true count:1, got $($r.Content)") }
        if (-not $mockLcu.Sync.LastPutBody) {
            $failures.Add('apply-itemsets 413-prune never issued a PUT')
        } else {
            $putObj = $mockLcu.Sync.LastPutBody | ConvertFrom-Json
            $putTitles = @($putObj.itemSets | ForEach-Object { $_.title })
            $coachAfter = @($putTitles | Where-Object { $_ -and ([string]$_).StartsWith('CoachBuild') })
            $userAfter = @($putTitles | Where-Object { -not ($_ -and ([string]$_).StartsWith('CoachBuild')) })
            if ($coachAfter.Count -ne 1) { $failures.Add("apply-itemsets 413-prune should leave exactly 1 CoachBuild set (the current one), got $($coachAfter.Count)") }
            if ($putTitles -notcontains "CoachBuild Viktor Mid $([char]0x2014) Core") { $failures.Add('apply-itemsets 413-prune dropped the current CoachBuild set') }
            if ($userAfter.Count -ne 3) { $failures.Add("apply-itemsets 413-prune must preserve all 3 user sets, got $($userAfter.Count)") }
            foreach ($t in @('My Poke Build', 'ARAM Full AP', 'Split Push Set')) {
                if ($putTitles -notcontains $t) { $failures.Add("apply-itemsets 413-prune dropped user set '$t'") }
            }
            # Total sets in the PUT must be bounded (3 user + 1 current = 4),
            # NOT the pre-existing 18 -- the payload-bounding guarantee.
            if (@($putObj.itemSets).Count -ne 4) { $failures.Add("apply-itemsets 413-prune payload not bounded: expected 4 total sets, got $(@($putObj.itemSets).Count)") }
        }
    } catch { $failures.Add("apply-itemsets 413-prune threw: $($_.Exception.Message)") }

    # 6h. v1.5.1/v1.6.2 -- apply-runes create-failed (FREE-SLOT create path:
    # no CoachBuild page exists, the POST that creates a fresh page is
    # rejected by the LCU) carries a status-coded hint instead of a bare
    # {ok:false, reason:'create-failed'} envelope. NB post-v1.6.2 the
    # CoachBuild-page path no longer POSTs at all (it edits in place, see
    # cases 6/6f) -- create-failed now only arises on a genuine create
    # (free-slot here, or the manual slots-full fallback).
    $mockLcu.Sync.MockPages = @()
    $mockLcu.Sync.MockCurrentPageId = $null
    $mockLcu.Sync.MockInventory = $null
    $mockLcu.Sync.PagePostShouldFail = $true
    $mockLcu.Sync.Calls.Clear()
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($applyBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if ($obj.ok -ne $false -or $obj.reason -ne 'create-failed') { $failures.Add("apply-runes create-failed expected create-failed envelope, got $($r.Content)") }
        if (-not $obj.hint -or $obj.hint -notlike '*new rune page*' -or $obj.hint -notlike '*HTTP 400*') {
            $failures.Add("apply-runes create-failed hint missing/wrong (expected mention of 'new rune page' + 'HTTP 400'), got $($r.Content)")
        }
    } catch { $failures.Add("apply-runes create-failed threw: $($_.Exception.Message)") }
    $mockLcu.Sync.PagePostShouldFail = $false
    $mockLcu.Sync.MockPages = @()

    # 6i. v1.5.1 -- apply-itemsets write-failed (the final PUT is rejected
    # by the LCU) now carries a status-coded hint instead of the old bare
    # {ok:false, reason:'write-failed'} envelope.
    $mockLcu.Sync.ExistingItemSets = [pscustomobject]@{ accountId = 12345; timestamp = 1700000000; itemSets = @() }
    $mockLcu.Sync.ItemSetsPutShouldFail = $true
    $mockLcu.Sync.LastPutBody = $null
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-itemsets?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes((@{ championId = 112; sets = $newSets } | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if ($obj.ok -ne $false -or $obj.reason -ne 'write-failed') { $failures.Add("apply-itemsets write-failed expected write-failed envelope, got $($r.Content)") }
        if (-not $obj.hint -or $obj.hint -notlike '*item-set write*' -or $obj.hint -notlike '*HTTP 500*') {
            $failures.Add("apply-itemsets write-failed hint missing/wrong (expected mention of 'item-set write' + 'HTTP 500'), got $($r.Content)")
        }
    } catch { $failures.Add("apply-itemsets write-failed threw: $($_.Exception.Message)") }
    $mockLcu.Sync.ItemSetsPutShouldFail = $false

    # 6j. v1.5.1 -- no-client (LcuPort not yet detected) now carries a fixed
    # hint on BOTH apply-runes and apply-itemsets, previously bare
    # {ok:false, reason:'no-client'} on both.
    $savedLcuPort = $bridge.Sync.LcuPort
    $bridge.Sync.LcuPort = $null
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes(($applyBody | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if ($obj.ok -ne $false -or $obj.reason -ne 'no-client' -or $obj.hint -ne 'League client not detected -- open the client and try again') {
            $failures.Add("apply-runes no-client hint wrong, got $($r.Content)")
        }
    } catch { $failures.Add("apply-runes no-client threw: $($_.Exception.Message)") }
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-itemsets?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ([Text.Encoding]::UTF8.GetBytes((@{ championId = 112; sets = $newSets } | ConvertTo-Json -Depth 10))) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if ($obj.ok -ne $false -or $obj.reason -ne 'no-client' -or $obj.hint -ne 'League client not detected -- open the client and try again') {
            $failures.Add("apply-itemsets no-client hint wrong, got $($r.Content)")
        }
    } catch { $failures.Add("apply-itemsets no-client threw: $($_.Exception.Message)") }
    $bridge.Sync.LcuPort = $savedLcuPort

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

    # 8b. v1.6.3 -Install immediate-launch command is well-formed, 100% ASCII,
    # and byte-identical to the command the .vbs runs (same hidden watcher).
    $launchCmd = Get-CompanionLaunchCommand -AppOrigin 'https://coachbuild.vercel.app'
    if ($launchCmd -ne 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://coachbuild.vercel.app/companion.ps1 | iex"') {
        $failures.Add("Install launch command malformed: $launchCmd")
    }
    if ($launchCmd -match '[^\x00-\x7F]') { $failures.Add("Install launch command is not ASCII: $launchCmd") }
    # The .vbs must wrap this SAME command (so immediate launch and autostart
    # can never diverge) -- the .vbs embeds it with doubled-quote escaping.
    if ($vbs -notlike '*powershell.exe -NoProfile -ExecutionPolicy Bypass -Command *irm https://coachbuild.vercel.app/companion.ps1 | iex*') {
        $failures.Add("Autostart VBS and Install launch command diverged: vbs=$vbs cmd=$launchCmd")
    }

    # 8c. v1.6.3 double-launch guard (Test-CompanionAlreadyRunning): false when
    # nothing holds the named mutex, true while an instance holds it. Uses the
    # SAME mutex name Start-Companion's Test-SingleInstance claims, so a real
    # running companion is correctly detected and -Install won't stack a second.
    if (Test-CompanionAlreadyRunning) {
        $failures.Add('Double-launch guard: reported already-running with no companion instance live')
    }
    $guardCreatedNew = $false
    $guardMutex = New-Object System.Threading.Mutex($true, 'Local\CoachBuildCompanion', [ref]$guardCreatedNew)
    try {
        if (-not $guardCreatedNew) {
            $failures.Add('Double-launch guard: could not claim the mutex for the test (an actual companion may be running)')
        }
        if (-not (Test-CompanionAlreadyRunning)) {
            $failures.Add('Double-launch guard: did NOT detect a held mutex -> -Install would spawn a duplicate')
        }
    } finally {
        try { $guardMutex.ReleaseMutex() } catch {}
        try { $guardMutex.Dispose() } catch {}
    }
    if (Test-CompanionAlreadyRunning) {
        $failures.Add('Double-launch guard: still reported running after the mutex was released/disposed')
    }

    # 8d. WHOLE-FILE ASCII guard (v1.6.3): companion.ps1 must be 100% ASCII --
    # PS 5.1 + the various encodings this script is downloaded/executed under
    # (irm | iex) make any non-ASCII byte (a stray box-drawing char in a
    # comment, a smart quote) a latent mojibake/parse risk. Read our own source
    # and fail if ANY byte is >= 0x80. Skipped when the source path is
    # unavailable (e.g. running via `irm | iex`, where $PSCommandPath is empty).
    if ($PSCommandPath -and (Test-Path $PSCommandPath)) {
        try {
            $srcBytes = [System.IO.File]::ReadAllBytes($PSCommandPath)
            $nonAscii = 0
            foreach ($b in $srcBytes) { if ($b -ge 0x80) { $nonAscii++ } }
            if ($nonAscii -gt 0) {
                $failures.Add("Source is not 100% ASCII: $nonAscii non-ASCII byte(s) in $PSCommandPath")
            }
        } catch {
            $failures.Add("Whole-file ASCII guard threw: $($_.Exception.Message)")
        }
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
    # v1.7.0 -- pin the browser-liveness guard ON for the whole mock run. Every
    # case here asserts the champ-select OPEN LOGIC; whether this dev/CI machine
    # happens to have a browser process running is irrelevant to that and must
    # never change an assertion's meaning. The guard's own behaviour is covered
    # by dedicated cases at the end, which flip this deliberately.
    $script:BrowserProbeOverride = $true
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

    # v1.6.0: every scenario BELOW this point (through the actions[]-only
    # resolution block) predates the "two pages simultaneously" ship and was
    # written/asserted purely against Builds opens. Simulate a /draft tab
    # already attached (LastDraftFollowAt fresh, LastBuildsFollowAt absent)
    # for this whole resolution-focused portion so those pre-existing
    # assertions keep testing exactly what they always tested (Builds
    # debounce + URL-format), undisturbed by the new two-page open decision
    # -- which gets its own dedicated, exhaustive "Attached-tab gate"
    # scenarios further down (neither/draft-only/Builds-only/both attached).
    $script:Bridge = [pscustomobject]@{ Sync = @{ LastBuildsFollowAt = $null; LastDraftFollowAt = (Get-Date).ToUniversalTime().ToString('o') } }

    Reset-ChampSelectState -State $state
    Reset-TabOpenGrace
    Update-ChampSelectState -State $state -Session (New-MockChampSelectSession -ChampId 0 -IntentId 103 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    Update-ChampSelectState -State $state -Session (New-MockChampSelectSession -ChampId 0 -IntentId 103 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    Update-ChampSelectState -State $state -Session (New-MockChampSelectSession -ChampId 103 -IntentId 103 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken

    # v1.6.4 BEHAVIOUR CHANGE (deliberate, this is the tab-spam fix): swapping
    # champion seconds after the Builds tab was opened must NOT open a second
    # tab. The tab opened for 103 is still cold-starting; once it boots it
    # live-follows champ select to 7 on its own (app/page.tsx's follow effect
    # off companion.tick), so a second open is pure tab spam. Pre-1.6.4 this
    # asserted 2 opens, which is how one champ-select could stack tabs.
    Update-ChampSelectState -State $state -Session (New-MockChampSelectSession -ChampId 7 -IntentId 7 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    $expected1 = "$appOrigin/?championId=103&role=0&session=$sessionToken"
    if ($script:OpenActions.Count -ne 1 -or $script:OpenActions[0] -ne $expected1) {
        $failures.Add("Champ swap during cold-start expected exactly 1 open ('$expected1'), got $($script:OpenActions.Count): $($script:OpenActions -join ' | ')")
    }

    # The debounce contract itself is unchanged: once the just-opened tab has
    # had its chance and demonstrably never attached (grace lapsed, no follow
    # poll), a genuine champion change DOES still re-open, with the role param
    # formatted exactly as before.
    Reset-TabOpenGrace
    Update-ChampSelectState -State $state -Session (New-MockChampSelectSession -ChampId 34 -IntentId 34 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    $expected2 = "$appOrigin/?championId=34&role=0&session=$sessionToken"
    if ($script:OpenActions.Count -ne 2) {
        $failures.Add("Champ swap after grace lapse expected a 2nd open, got $($script:OpenActions.Count): $($script:OpenActions -join ' | ')")
    } elseif ($script:OpenActions[1] -ne $expected2) {
        $failures.Add("Open #2 mismatch: got $($script:OpenActions[1]) want $expected2")
    }

    # Role-LESS check (v1.2.0 fix -- was a live-reported bug: v1.1.0 silently
    # skipped opening ENTIRELY for a blank/unmapped assignedPosition, i.e.
    # every custom lobby, blind pick, and ARAM game). Must still open, just
    # WITHOUT a role param.
    $script:OpenActions.Clear()
    Reset-TabOpenGrace  # independent scenario -- the previous block's opens must not suppress it
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
    Reset-TabOpenGrace  # independent scenario -- see the role-less block above
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

    # Attached-tab gate (v1.3.0 live-follow fold-in, NARROWED in v1.5.0 to
    # follow-capable pollers only, split PER-KIND in v1.6.0 "two pages
    # simultaneously" ship): Builds and /draft are now tracked and
    # opened/suppressed INDEPENDENTLY via LastBuildsFollowAt/
    # LastDraftFollowAt. -Mock fakes a lightweight $script:Bridge (no real
    # HttpListener) purely so Test-CompanionHasAttachedTab has something to
    # read -- these fields are what a real bridge's /status handler would
    # have stamped from `follow=builds`/`follow=draft`/legacy `follow=1`
    # (that HTTP-level parsing itself is covered by -SelfTest, which runs a
    # real bridge; see Invoke-SelfTest's own "follow=<kind> stamping" case).
    # v1.6.4: each sub-test below isolates the FOLLOW-STAMP gate, so the
    # open->attach grace is reset before each one -- otherwise the opens
    # performed by the previous sub-test would legitimately suppress the next
    # one's expected open. The grace has its own dedicated cases further down.
    # v1.7.0: these cases isolate the FOLLOW-STAMP gate, so the browser-liveness
    # guard is pinned to "a browser is running" -- otherwise every "attached"
    # assertion below would flip on a machine with no browser open (CI, or a
    # dev box mid-restart), asserting the wrong thing entirely. The guard has
    # its own dedicated cases further down, which flip this to $false.
    $script:BrowserProbeOverride = $true
    $script:Bridge = [pscustomobject]@{ Sync = @{ LastBuildsFollowAt = $null; LastDraftFollowAt = $null; LastBuildsDetachAt = $null; LastDraftDetachAt = $null } }
    $attachState = @{ LastOpenedChampId = $null }
    Reset-TabOpenGrace

    # Neither attached -> open BOTH, Builds first then /draft last (exact
    # order asserted -- Start-Process order is the best-effort OS focus
    # order the user directive relies on to land on /draft as the main
    # focus page). This is also the back-compat path: a stale cached web
    # build that never sends any follow param (pre-1.5.0 client, or only a
    # non-follow-capable page like /live-setup is open) never sets either
    # field, so it always degrades to opening both fresh.
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 103 -IntentId 103 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    $expectedBuilds103 = "$appOrigin/?championId=103&role=0&session=$sessionToken"
    $expectedDraft = "$appOrigin/draft?session=$sessionToken"
    if ($script:OpenActions.Count -ne 2) {
        $failures.Add("Attached-tab gate (neither attached): expected 2 opens (Builds then draft), got $($script:OpenActions.Count): $($script:OpenActions -join ' | ')")
    } else {
        if ($script:OpenActions[0] -ne $expectedBuilds103) { $failures.Add("Attached-tab gate (neither attached): open #1 should be Builds, got $($script:OpenActions[0])") }
        if ($script:OpenActions[1] -ne $expectedDraft) { $failures.Add("Attached-tab gate (neither attached): open #2 should be /draft, got $($script:OpenActions[1])") }
    }

    # Only draft attached -> open Builds only.
    Reset-TabOpenGrace
    $script:Bridge.Sync.LastDraftFollowAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:Bridge.Sync.LastBuildsFollowAt = $null
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 7 -IntentId 7 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    $expectedBuilds7 = "$appOrigin/?championId=7&role=0&session=$sessionToken"
    if ($script:OpenActions.Count -ne 1 -or $script:OpenActions[0] -ne $expectedBuilds7) {
        $failures.Add("Attached-tab gate (draft-only attached): expected exactly 1 open (Builds), got $($script:OpenActions.Count): $($script:OpenActions -join ' | ')")
    }

    # Only Builds attached -> open /draft only.
    Reset-TabOpenGrace
    $script:Bridge.Sync.LastBuildsFollowAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:Bridge.Sync.LastDraftFollowAt = $null
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 64 -IntentId 64 -Position 'jungle') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 1 -or $script:OpenActions[0] -ne $expectedDraft) {
        $failures.Add("Attached-tab gate (Builds-only attached): expected exactly 1 open (/draft), got $($script:OpenActions.Count): $($script:OpenActions -join ' | ')")
    }

    # Both attached -> no opens at all, but debounce state still advances
    # (both tabs already live-follow via their own polls).
    Reset-TabOpenGrace
    $script:Bridge.Sync.LastBuildsFollowAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:Bridge.Sync.LastDraftFollowAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 22 -IntentId 22 -Position 'bottom') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 0) {
        $failures.Add("Attached-tab gate (both attached): expected NO opens, got $($script:OpenActions.Count)")
    }
    if ($attachState.LastOpenedChampId -ne 22) {
        $failures.Add('Attached-tab gate (both attached): debounce state did not advance even though both tab-follow paths are responsible for it')
    }

    # v1.6.4 THROTTLED-TAB REGRESSION: a hidden tab behind a fullscreen game
    # is throttled by Chrome to roughly one timer tick per MINUTE. A 60s-old
    # follow poll therefore means "alive and following", not "gone" -- under
    # the old 8s window this was the tab-spam bug (both tabs re-opened every
    # champ-select, piling up across games). Must count as ATTACHED.
    Reset-TabOpenGrace
    $script:Bridge.Sync.LastBuildsFollowAt = (Get-Date).ToUniversalTime().AddSeconds(-60).ToString('o')
    $script:Bridge.Sync.LastDraftFollowAt = (Get-Date).ToUniversalTime().AddSeconds(-60).ToString('o')
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 51 -IntentId 51 -Position 'middle') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 0) {
        $failures.Add("Throttled-tab gate (60s-old follow polls): expected NO opens -- a background-throttled tab is still attached -- got $($script:OpenActions.Count)")
    }

    # Both polls genuinely stale (tabs actually closed, well past the widened
    # window) -> the NEXT champion change resumes opening both fresh, in the
    # same Builds-then-draft order.
    Reset-TabOpenGrace
    $script:Bridge.Sync.LastBuildsFollowAt = (Get-Date).ToUniversalTime().AddSeconds(-300).ToString('o')
    $script:Bridge.Sync.LastDraftFollowAt = (Get-Date).ToUniversalTime().AddSeconds(-300).ToString('o')
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 45 -IntentId 45 -Position 'utility') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 2) {
        $failures.Add("Attached-tab gate (both stale): expected 2 opens to resume once both polls go stale, got $($script:OpenActions.Count)")
    }

    # v1.6.4 OPEN->ATTACH RACE: the two opens above just happened, and a
    # freshly opened tab cannot have polled yet. A champion change inside that
    # cold-start gap must NOT open a second pair -- that race is how a single
    # champ-select could produce 4 tabs. Follow fields deliberately left at
    # their stale 300s values: the grace alone must carry this.
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 67 -IntentId 67 -Position 'bottom') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 0) {
        $failures.Add("Open->attach race: a champion change right after opening must not re-open (tabs are still cold-starting), got $($script:OpenActions.Count) extra opens")
    }

    # ...but the grace is not a permanent suppressor: once it lapses with the
    # tabs still never having polled, the open genuinely failed and the next
    # champion change must try again.
    $script:LastTabOpenAt.builds = (Get-Date).AddSeconds(-($script:OpenGraceSeconds + 5))
    $script:LastTabOpenAt.draft = (Get-Date).AddSeconds(-($script:OpenGraceSeconds + 5))
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 89 -IntentId 89 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 2) {
        $failures.Add("Open grace lapse: after the grace expires with no follow poll the open must be retried, got $($script:OpenActions.Count)")
    }

    # -- v1.7.0: "the browser was closed, so nothing ever opened" -------------
    # THE live-reported bug (2026-07-26). A tab that polled seconds before the
    # browser closed leaves a stamp that stays fresh for AttachWindowSeconds
    # (150s) -- most of a champ-select -- so every kind looked attached and the
    # companion opened nothing at all. Two independent signals now break that.

    # (a) EXPLICIT DETACH (pagehide / nav away from a follow-capable route).
    # Stamps are seconds old, i.e. maximally "attached" by the old rule; the
    # detach must still make the next champion change open both.
    Reset-TabOpenGrace
    $script:Bridge.Sync.LastBuildsFollowAt = $null
    $script:Bridge.Sync.LastDraftFollowAt = $null
    $script:Bridge.Sync.LastBuildsDetachAt = $null
    $script:Bridge.Sync.LastDraftDetachAt = $null
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 12 -IntentId 12 -Position 'utility') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 2) {
        $failures.Add("Detach precondition: expected the initial 2 opens, got $($script:OpenActions.Count)")
    }
    # Both tabs now report in (as a real browser would), then the user closes
    # the browser and each page fires its detach beacon on pagehide.
    $script:Bridge.Sync.LastBuildsFollowAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:Bridge.Sync.LastDraftFollowAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 55 -IntentId 55 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 0) {
        $failures.Add("Detach setup: with both tabs freshly polling, a champion change must not open anything, got $($script:OpenActions.Count)")
    }
    # The bridge handler's detach branch, replayed at the state level (its HTTP
    # parsing has its own -SelfTest cases against a real bridge). The sleep is
    # load-bearing, not padding: Get-Date's resolution on Windows is ~15.6ms, so
    # without it the detach can land on the exact same tick as the open above
    # and the "detach must be strictly AFTER the open" rule (deliberately
    # strict -- see Test-TabOpenGraceActive) would read it as a stale detach.
    Start-Sleep -Milliseconds 30
    $script:Bridge.Sync.LastBuildsFollowAt = $null
    $script:Bridge.Sync.LastDraftFollowAt = $null
    $script:Bridge.Sync.LastBuildsDetachAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:Bridge.Sync.LastDraftDetachAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 99 -IntentId 99 -Position 'jungle') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 2) {
        $failures.Add("Detach: after both pages detached, the next champion change must re-open BOTH (this is the live-reported browser-closed bug), got $($script:OpenActions.Count)")
    }

    # (b) A detach ALSO voids an open->attach grace. Opening a tab and closing
    # it inside the 25s grace previously left that kind suppressed for the rest
    # of the window -- the grace is there to wait for an answer, and a detach IS
    # the answer.
    Reset-TabOpenGrace
    $script:Bridge.Sync.LastBuildsFollowAt = $null
    $script:Bridge.Sync.LastDraftFollowAt = $null
    $script:Bridge.Sync.LastBuildsDetachAt = $null
    $script:Bridge.Sync.LastDraftDetachAt = $null
    Set-TabOpenedNow -Kind builds
    Set-TabOpenedNow -Kind draft
    if (-not (Test-TabOpenGraceActive -Kind builds)) {
        $failures.Add('Grace precondition: a just-opened kind must be inside its grace')
    }
    Start-Sleep -Milliseconds 30  # same ~15.6ms Get-Date resolution reason as above
    $script:Bridge.Sync.LastBuildsDetachAt = (Get-Date).ToUniversalTime().ToString('o')
    if (Test-TabOpenGraceActive -Kind builds) {
        $failures.Add('Detach vs grace: a detach recorded AFTER the open must void the grace for that kind')
    }
    if (-not (Test-TabOpenGraceActive -Kind draft)) {
        $failures.Add('Detach vs grace: a Builds detach must not void the DRAFT grace')
    }
    # A detach from BEFORE the open (a previous game's close) must not void it.
    $script:Bridge.Sync.LastBuildsDetachAt = (Get-Date).ToUniversalTime().AddSeconds(-600).ToString('o')
    if (-not (Test-TabOpenGraceActive -Kind builds)) {
        $failures.Add('Detach vs grace: a STALE detach predating the open must not void the grace')
    }

    # (c) BROWSER-LIVENESS GUARD -- the hard-kill case, where no pagehide ever
    # fires (task-kill, crash, sign-out). Fresh stamps, no detach: with a
    # browser running these count as attached; with none running they must not.
    Reset-TabOpenGrace
    $script:Bridge.Sync.LastBuildsFollowAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:Bridge.Sync.LastDraftFollowAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:Bridge.Sync.LastBuildsDetachAt = $null
    $script:Bridge.Sync.LastDraftDetachAt = $null
    $script:BrowserProbeOverride = $false
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 33 -IntentId 33 -Position 'middle') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 2) {
        $failures.Add("Browser-liveness guard: with NO browser process running, fresh follow stamps must not suppress the opens, got $($script:OpenActions.Count)")
    }
    $script:BrowserProbeOverride = $true
    Reset-TabOpenGrace
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $attachState -Session (New-MockChampSelectSession -ChampId 34 -IntentId 34 -Position 'middle') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 0) {
        $failures.Add("Browser-liveness guard: with a browser running, fresh follow stamps must still suppress (the guard only ever WIDENS opening), got $($script:OpenActions.Count)")
    }

    # -- v1.7.0 PRE-WARM: champ-select ENTRY opens the pages, before any hover -
    # "Have the pages ready" -- a cold browser boots during bans instead of at
    # the first pick. Builds is session-only here (no championId exists yet).
    Reset-TabOpenGrace
    $script:Bridge.Sync.LastBuildsFollowAt = $null
    $script:Bridge.Sync.LastDraftFollowAt = $null
    $script:Bridge.Sync.LastBuildsDetachAt = $null
    $script:Bridge.Sync.LastDraftDetachAt = $null
    $script:OpenActions.Clear()
    Invoke-ChampSelectPrewarm -AppOrigin $appOrigin -SessionToken $sessionToken
    $expectedPrewarmBuilds = "$appOrigin/?session=$sessionToken"
    if ($script:OpenActions.Count -ne 2) {
        $failures.Add("Prewarm (nothing attached): expected 2 opens, got $($script:OpenActions.Count): $($script:OpenActions -join ' | ')")
    } else {
        if ($script:OpenActions[0] -ne $expectedPrewarmBuilds) { $failures.Add("Prewarm: open #1 must be the session-only Builds URL (no championId exists yet), got $($script:OpenActions[0])") }
        if ($script:OpenActions[1] -ne $expectedDraft) { $failures.Add("Prewarm: open #2 must be /draft, got $($script:OpenActions[1])") }
    }
    # The pre-warm stamped the grace, so the first champion resolution must NOT
    # open a second pair -- the pre-warmed tab live-follows it in place. This is
    # the interaction that would otherwise turn "ready earlier" into tab spam.
    $prewarmState = @{ LastOpenedChampId = $null }
    $script:OpenActions.Clear()
    Update-ChampSelectState -State $prewarmState -Session (New-MockChampSelectSession -ChampId 84 -IntentId 84 -Position 'top') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 0) {
        $failures.Add("Prewarm: the first champion resolution after a prewarm must not open a second pair, got $($script:OpenActions.Count)")
    }
    if ($prewarmState.LastOpenedChampId -ne 84) {
        $failures.Add('Prewarm: debounce state must still advance on the suppressed resolution')
    }
    # Already-attached tabs: the pre-warm must be a no-op, not two more tabs.
    Reset-TabOpenGrace
    $script:Bridge.Sync.LastBuildsFollowAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:Bridge.Sync.LastDraftFollowAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:OpenActions.Clear()
    Invoke-ChampSelectPrewarm -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 0) {
        $failures.Add("Prewarm (both attached): expected NO opens, got $($script:OpenActions.Count)")
    }
    # Only one side attached -> pre-warm opens only the missing one.
    Reset-TabOpenGrace
    $script:Bridge.Sync.LastBuildsFollowAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:Bridge.Sync.LastDraftFollowAt = $null
    $script:OpenActions.Clear()
    Invoke-ChampSelectPrewarm -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 1 -or $script:OpenActions[0] -ne $expectedDraft) {
        $failures.Add("Prewarm (Builds attached): expected exactly 1 open (/draft), got $($script:OpenActions.Count): $($script:OpenActions -join ' | ')")
    }

    Reset-TabOpenGrace
    $script:BrowserProbeOverride = $null
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
