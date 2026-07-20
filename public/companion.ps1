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
    assignedPosition -- never summonerId or any name field.
  - Rune-page apply happens ONLY via a user-clicked button on the web app
    (POST /apply-runes). This script never writes runes on its own.
  - /live is a raw, unmodified passthrough of the official Live Client Data
    API (127.0.0.1:2999). No cooldown/timer/power-spike computation here or
    anywhere downstream in this repo.

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
                                clientConnected:boolean}
  - GET  /live         -> 200 <raw allgamedata JSON> | 200 {error:"no-live"}
  - POST /apply-runes  body {name, primaryStyleId, subStyleId,
                              selectedPerkIds:number[9], current:true}
                       -> 200 {ok:true}
                        | 200 {ok:false, reason:string, hint?:string}
  - Champ-select flow is ZERO-BRIDGE: the companion opens
    "<AppOrigin>/?championId=<id>&role=<0-4>&session=<token>" directly via
    Start-Process. RoleId map: top=0 jungle=1 middle=2 bottom=3 utility=4
    (LCU assignedPosition strings -> numeric RoleId; "" / unmapped = skip).

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
    Version     = '1.0.0'
    AppOrigin   = 'https://coachbuild.vercel.app'
    BridgePorts = @(48291, 48292, 48293)
    PollMs      = 1500
    LivePollMs  = 1000
    Session     = ([guid]::NewGuid().ToString('N'))
}
$script:MockMode = $false
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
        $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
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
    param([string]$AppOrigin, [string]$SessionToken, [int]$ChampionId, [int]$RoleId)
    return "$AppOrigin/?championId=$ChampionId&role=$RoleId&session=$SessionToken"
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

function Update-ChampSelectState {
    # Debounce rule (plan §1): open once per champ-select, re-open ONLY on
    # an actual championId change. Never reopen on a timer tick or a
    # teammate's action -- Reset-ChampSelectState is the only thing allowed
    # to clear LastOpenedChampId, and it's called only on ChampSelect ENTRY.
    param($State, $Session, [string]$AppOrigin, [string]$SessionToken)
    $cell = Get-MyChampSelectCell -Session $Session
    if (-not $cell) { return }

    $champId = [int]$cell.championId
    if ($champId -le 0) { $champId = [int]$cell.championPickIntent }
    if ($champId -le 0) { return }  # nothing hovered or locked yet

    $roleId = Get-RoleIdFromPosition -Position $cell.assignedPosition
    if ($null -eq $roleId) { return }

    if ($State.LastOpenedChampId -eq $champId) { return }  # no change -- debounce

    $State.LastOpenedChampId = $champId
    $State.LastOpenedRoleId = $roleId
    $url = Get-DeepLinkUrl -AppOrigin $AppOrigin -SessionToken $SessionToken -ChampionId $champId -RoleId $roleId
    Open-CompanionUrl -Url $url
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
            }
        } elseif ($path -eq '/live' -and $req.HttpMethod -eq 'GET') {
            $live = Get-LiveClientData
            if ($null -eq $live) {
                Write-JsonResponse -Response $res -StatusCode 200 -Obj @{ error = 'no-live' }
            } else {
                Write-JsonResponse -Response $res -StatusCode 200 -Obj $live
            }
        } elseif ($path -eq '/apply-runes' -and $req.HttpMethod -eq 'POST') {
            $reader = New-Object IO.StreamReader($req.InputStream, $req.ContentEncoding)
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
            }
        } else {
            Write-JsonResponse -Response $res -StatusCode 404 -Obj @{ error = 'not-found' }
        }
    } catch {
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
        Running     = $true
        Listener    = $listener
        AppOrigin   = $AppOrigin
        Session     = $Session
        Version     = $Version
        BridgePort  = $port
        Phase       = 'None'
        LcuPort     = $null
        LcuToken    = $null
        LcuScheme   = 'https'
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

    $script:Bridge = Start-BridgeServer -AppOrigin $script:Config.AppOrigin -Ports $script:Config.BridgePorts -Session $script:Config.Session -Version $script:Config.Version
    $script:ChampSelectState = @{ LastOpenedChampId = $null; LastOpenedRoleId = $null }
    $script:WasChampSelect = $false

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
        if ($champId -and ($null -ne $roleId)) {
            $url = Get-DeepLinkUrl -AppOrigin $script:Config.AppOrigin -SessionToken $script:Config.Session -ChampionId $champId -RoleId $roleId
            Open-CompanionUrl -Url $url
        } else {
            Open-CompanionUrl -Url $script:Config.AppOrigin
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
function Install-Companion {
    $wsh = New-Object -ComObject WScript.Shell
    $startup = [Environment]::GetFolderPath('Startup')
    $lnkPath = Join-Path $startup 'CoachBuildCompanion.lnk'
    $shortcut = $wsh.CreateShortcut($lnkPath)
    $shortcut.TargetPath = 'powershell.exe'
    $shortcut.Arguments = "-WindowStyle Hidden -ExecutionPolicy Bypass -Command `"irm $($script:Config.AppOrigin)/companion.ps1 | iex`""
    $shortcut.Description = 'CoachBuild Live companion'
    $shortcut.Save()
    Write-Host "Installed startup shortcut: $lnkPath"
}

function Uninstall-Companion {
    $startup = [Environment]::GetFolderPath('Startup')
    $lnkPath = Join-Path $startup 'CoachBuildCompanion.lnk'
    if (Test-Path $lnkPath) {
        Remove-Item $lnkPath -Force
        Write-Host "Removed $lnkPath"
    } else {
        Write-Host 'No startup shortcut found.'
    }
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
        Running          = $true
        Listener         = $listener
        DeleteShouldFail = $false
        Calls            = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
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
        foreach ($k in 'version', 'port', 'phase', 'clientConnected') {
            if (-not ($obj.PSObject.Properties.Name -contains $k)) { $failures.Add("/status missing field $k") }
        }
    } catch { $failures.Add("/status request threw: $($_.Exception.Message)") }

    # 5. apply-runes happy path: GET -> DELETE -> POST sequencing
    $mockLcu.Sync.DeleteShouldFail = $false
    $mockLcu.Sync.Calls.Clear()
    $applyBody = @{ name = 'CoachBuild Test'; primaryStyleId = 8000; subStyleId = 8100; selectedPerkIds = @(8005, 9111, 9104, 8014, 8017, 8009, 8017, 5008, 5008); current = $true }
    try {
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ($applyBody | ConvertTo-Json -Depth 10) -ContentType 'application/json' -UseBasicParsing
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
        $r = Invoke-WebRequest -Uri "$base/apply-runes?session=$session" -Method POST -Headers @{ Origin = $appOrigin } -Body ($applyBody | ConvertTo-Json -Depth 10) -ContentType 'application/json' -UseBasicParsing
        $obj = $r.Content | ConvertFrom-Json
        if ($obj.ok -ne $false -or $obj.reason -ne 'delete-failed' -or -not $obj.hint) {
            $failures.Add("apply-runes delete-fail envelope wrong: $($r.Content)")
        }
        if (@($mockLcu.Sync.Calls) -contains 'POST') { $failures.Add('apply-runes POSTed after a failed delete (#1013 fail-soft violated)') }
    } catch { $failures.Add("apply-runes delete-fail threw: $($_.Exception.Message)") }

    Stop-BridgeServer -Bridge $bridge
    Stop-MockLcu -Mock $mockLcu

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
        param([int]$ChampId, [int]$IntentId, [string]$Position)
        return [pscustomobject]@{
            localPlayerCellId = 0
            myTeam            = @([pscustomobject]@{ cellId = 0; championId = $ChampId; championPickIntent = $IntentId; assignedPosition = $Position })
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

    # Role-skip check: an unassigned position (ARAM-style "") must never open.
    $script:OpenActions.Clear()
    $skipState = @{ LastOpenedChampId = $null }
    Update-ChampSelectState -State $skipState -Session (New-MockChampSelectSession -ChampId 99 -IntentId 99 -Position '') -AppOrigin $appOrigin -SessionToken $sessionToken
    if ($script:OpenActions.Count -ne 0) {
        $failures.Add("Blank assignedPosition should never open a deep link, got $($script:OpenActions.Count)")
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
