[CmdletBinding()]
param(
    [ValidateSet('Audit', 'Capture', 'All')]
    [string]$Mode = 'Audit',
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$OutputDirectory,
    [string]$ApplicationPath,
    [string]$PreviewProject,
    [ValidateSet('companion', 'ugg', 'coachless')]
    [string[]]$Tabs = @('companion', 'ugg', 'coachless'),
    [int]$WindowTimeoutSeconds = 45,
    [int]$SettleMilliseconds = 8000,
    [switch]$SkipBuild,
    [switch]$SkipTests,
    [ValidateSet('companion', 'ugg', 'coachless')]
    [string]$ErrorTab = 'ugg',
    [switch]$SkipError,
    [switch]$KeepProfiles
)

$ErrorActionPreference = 'Stop'

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $desktopRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot '_evidence\companion-tabs'
}
if ([string]::IsNullOrWhiteSpace($PreviewProject)) {
    $PreviewProject = Join-Path $desktopRoot 'tools\CompanionTabsPreview\CompanionTabsPreview.csproj'
}
if ([string]::IsNullOrWhiteSpace($ApplicationPath)) {
    $ApplicationPath = Join-Path $desktopRoot "src\CoachBuild.Desktop\bin\$Configuration\net8.0-windows\CoachBuild.Desktop.exe"
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$dotnet = $null
$candidateSdk = 'C:\Users\Ht\AppData\Local\Microsoft\dotnet\dotnet.exe'
if (Test-Path -LiteralPath $candidateSdk) {
    $dotnet = $candidateSdk
}
else {
    $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($dotnetCommand) { $dotnet = $dotnetCommand.Source }
}

$checks = [System.Collections.Generic.List[object]]::new()
$risks = [System.Collections.Generic.List[string]]::new()
$screenshotPaths = [System.Collections.Generic.List[string]]::new()
$files = [System.Collections.Generic.List[string]]::new()

function Add-Check {
    param(
        [string]$Name,
        [bool]$Passed,
        [string]$Detail,
        [ValidateSet('pass', 'fail', 'skip')]
        [string]$Status = $(if ($Passed) { 'pass' } else { 'fail' })
    )
    $checks.Add([pscustomobject]@{
        name = $Name
        status = $Status
        passed = $Passed
        detail = $Detail
    })
}

function Invoke-CheckedCommand {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$WorkingDirectory = $repoRoot
    )
    if (-not (Test-Path -LiteralPath $FilePath)) {
        Add-Check $Name $false "Command not found: $FilePath"
        return $false
    }

    $output = & $FilePath @ArgumentList 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
        Add-Check $Name $true 'completed successfully'
        return $true
    }

    $tail = ($output.Trim() -split "`r?`n" | Select-Object -Last 8) -join ' | '
    Add-Check $Name $false "exit ${exitCode}: $tail"
    return $false
}

function Get-CodeWithoutComments {
    param([string]$Text)
    # Remove block comments before checking call syntax. Do not remove `//`
    # lines with a regex: that would also remove the `//` in https:// URLs.
    $withoutBlocks = [regex]::Replace($Text, '/\*.*?\*/', '', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    return $withoutBlocks
}

function Invoke-SourceAudit {
    $webRoot = Join-Path $desktopRoot 'src\CoachBuild.Desktop\Web'
    $tabFiles = @(Get-ChildItem -LiteralPath $webRoot -File -Filter '*.cs' |
        Where-Object { $_.Name -match '(?i)(tab|site)' })
    $tabFileNames = @($tabFiles | ForEach-Object { $_.Name })
    $tabFiles | ForEach-Object { $files.Add($_.FullName) }

    if ($tabFiles.Count -eq 0) {
        Add-Check 'tab source present' $false "No tab/site source files were found under $webRoot"
        $risks.Add('The tab implementation is absent from this checkout; capture cannot prove the release UI.')
        return
    }
    Add-Check 'tab source present' $true ($tabFileNames -join ', ')

    $code = ($tabFiles | ForEach-Object {
        Get-CodeWithoutComments (Get-Content -Raw -LiteralPath $_.FullName)
    }) -join "`n"

    # WebView2Window owns the one allowed script call: it reads the hosted
    # Companion page's version marker for the existing freshness check. Audit
    # that call separately so a future site-tab change cannot silently turn
    # the broad no-scraping check into a false pass.
    $windowPath = Join-Path $webRoot 'WebView2Window.xaml.cs'
    $windowCode = if (Test-Path -LiteralPath $windowPath) {
        $files.Add((Resolve-Path -LiteralPath $windowPath).Path)
        Get-CodeWithoutComments (Get-Content -Raw -LiteralPath $windowPath)
    }
    else { '' }
    $hasSiteScript = $code -match '(?i)\.\s*ExecuteScriptAsync\s*\(|AddScriptToExecuteOnDocumentCreated\s*\(|\.\s*WebResourceRequested\s*\+=' 
    $hasAnyScript = $hasSiteScript -or
        $windowCode -match '(?i)\.\s*AddScriptToExecuteOnDocumentCreated\s*\(|\.\s*WebResourceRequested\s*\+='
    $hostScriptGuard = $windowCode -match '(?is)if\s*\(\s*state\.Tab\s*!=\s*CompanionTab\.Companion\s*\)\s*return'
    $scriptDetail = if ($hasSiteScript) {
        'A DOM/script/network interception API appears in tab/site code.'
    }
    elseif ($hasAnyScript -and $hostScriptGuard) {
        'The only script-capable window path is guarded to the hosted Companion tab; site-tab code is rendering-only.'
    }
    elseif ($hasAnyScript) {
        'A script/network interception API appears in the window without a visible hosted-tab guard.'
    }
    else {
        'No DOM/script/network interception API appears in the tab window.'
    }
    Add-Check 'third-party tabs do not scrape or inject site DOM' (-not $hasSiteScript -and (-not $hasAnyScript -or $hostScriptGuard)) $scriptDetail
    if ($hasSiteScript -or ($hasAnyScript -and -not $hostScriptGuard)) {
        $risks.Add('Site-tab code contains a scraping or unguarded script/network interception API; review before release.')
    }

    $popupHandlerPresent = $windowCode -match '(?i)OnNewWindowRequested'
    $popupUsesSameTab = $windowCode -match '(?i)IsUserInitiated' -and
        $windowCode -match '(?i)args\.Uri' -and
        $windowCode -match '(?i)Navigate\s*\('
    $popupDetail = if (-not $popupHandlerPresent) {
        'No WebView2 new-window handler was found.'
    }
    elseif ($popupUsesSameTab) {
        'User-initiated target=_blank navigation has a same-tab navigation path.'
    }
    else {
        'The new-window handler does not show a user-initiated same-tab navigation path.'
    }
    Add-Check 'user-initiated target=_blank stays in the active tab' (-not $popupHandlerPresent -or $popupUsesSameTab) $popupDetail
    if ($popupHandlerPresent -and -not $popupUsesSameTab) {
        $risks.Add('A target=_blank click may be discarded instead of navigating the active companion tab.')
    }

    $hasTabLifecycle = $windowCode -match '(?i)EnsureTabAsync\s*\(' -and
        $windowCode -match '(?i)ProfileFolder\s*\(' -and
        $windowCode -match '(?i)DisposeBrowser\s*\('
    $lifecycleDetail = if ($hasTabLifecycle) {
        'Lazy tab creation, per-tab profile routing, and explicit browser disposal are present in the window.'
    }
    else {
        'Could not find all lazy-creation, profile-routing, and disposal seams in WebView2Window.'
    }
    Add-Check 'lazy tab lifecycle and explicit disposal seams present' $hasTabLifecycle $lifecycleDetail
    if (-not $hasTabLifecycle) {
        $risks.Add('The WebView2 window does not expose all lifecycle seams needed to prove lazy creation and cleanup.')
    }

    $hasSessionLiteral = $code -match '(?i)["''](?:https?://|/)[^"'']*session=[^"'']*["'']'
    $sessionDetail = if ($hasSessionLiteral) {
        'A literal URL containing session= appears in tab/site code.'
    }
    else {
        'No literal session= URL appears in tab/site code.'
    }
    Add-Check 'third-party URLs do not embed session credentials' (-not $hasSessionLiteral) $sessionDetail
    if ($hasSessionLiteral) {
        $risks.Add('A third-party tab URL appears to carry the companion session token.')
    }

    $usesHttpsSites = $code -match '(?i)https://u\.gg' -and $code -match '(?i)https://coachless\.gg'
    $originDetail = if ($usesHttpsSites) {
        'Both requested site origins are explicit HTTPS URLs.'
    }
    else {
        'Could not find explicit HTTPS origins for both requested sites.'
    }
    Add-Check 'u.gg and Coachless use HTTPS origins' $usesHttpsSites $originDetail
    if (-not $usesHttpsSites) {
        $risks.Add('One or both requested site origins are missing from the tab source or are not HTTPS.')
    }

    $hasProfileModel = $code -match '(?i)ProfileFolder\s*\(' -and
        $code -match '(?i)CompanionTabsPreferences'
    $profileDetail = if ($hasProfileModel) {
        'Tab-specific profile routing and persisted last-tab/zoom models are present.'
    }
    else {
        'Could not find both profile routing and preference models.'
    }
    Add-Check 'profile and browser-chrome preference models present' $hasProfileModel $profileDetail
    if (-not $hasProfileModel) {
        $risks.Add('The tab source does not expose the profile/preferences seams required for isolation and restart recovery.')
    }
}

function Invoke-TestAudit {
    if ($SkipTests) {
        Add-Check 'CompanionTabsIntegrationTests' $true 'skipped by -SkipTests' 'skip'
        return
    }
    if ($null -eq $dotnet) {
        Add-Check 'CompanionTabsIntegrationTests' $false 'No .NET SDK executable was found.'
        $risks.Add('The targeted .NET QA tests were not run because no dotnet SDK was available.')
        return
    }
    $testProject = Join-Path $desktopRoot 'tests\CoachBuild.Desktop.Tests\CoachBuild.Desktop.Tests.csproj'
    $testArgs = @('test', $testProject, '-c', $Configuration, '--filter', 'FullyQualifiedName~CompanionTabsIntegrationTests', '--no-restore')
    if (-not (Invoke-CheckedCommand 'CompanionTabsIntegrationTests' $dotnet $testArgs)) {
        $risks.Add('The focused companion-tabs .NET tests failed; do not treat this checkout as release-ready.')
    }
}

function Add-ScreenshotInterop {
    if (-not ('CoachBuild.CompanionTabsQa.NativeMethods' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace CoachBuild.CompanionTabsQa {
    public static class NativeMethods {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    }
}
'@
    }
}

function Get-DesktopSessionState {
    Add-ScreenshotInterop
    $foreground = [CoachBuild.CompanionTabsQa.NativeMethods]::GetForegroundWindow()
    [uint32]$ownerProcessId = 0
    if ($foreground -ne [IntPtr]::Zero) {
        [void][CoachBuild.CompanionTabsQa.NativeMethods]::GetWindowThreadProcessId(
            $foreground,
            [ref]$ownerProcessId)
    }
    $owner = if ($ownerProcessId -gt 0) {
        Get-Process -Id $ownerProcessId -ErrorAction SilentlyContinue
    }
    else { $null }
    $ownerName = if ($owner) { $owner.ProcessName } else { 'none' }
    [pscustomobject]@{
        locked = $ownerName -eq 'LockApp' -or $foreground -eq [IntPtr]::Zero
        foregroundProcess = $ownerName
        foregroundHandle = $foreground.ToInt64()
    }
}

function Save-WindowScreenshot {
    param(
        [System.Diagnostics.Process]$Process,
        [string]$Path
    )
    Add-ScreenshotInterop
    $handle = $Process.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) { throw 'The preview process has no main window handle.' }
    $rect = [CoachBuild.CompanionTabsQa.NativeMethods+RECT]::new()
    if (-not [CoachBuild.CompanionTabsQa.NativeMethods]::GetWindowRect($handle, [ref]$rect)) {
        throw 'GetWindowRect failed for the preview window.'
    }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { throw "Invalid window rectangle ${width}x${height}." }
    Add-Type -AssemblyName System.Drawing
    $bitmap = [System.Drawing.Bitmap]::new($width, $height)
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            # CopyFromScreen is black when the agent session is on a nonactive
            # desktop. PrintWindow asks the real WPF HWND to render itself and
            # also captures WebView2's composed content (PW_RENDERFULLCONTENT).
            $dc = $graphics.GetHdc()
            try {
                $printed = [CoachBuild.CompanionTabsQa.NativeMethods]::PrintWindow($handle, $dc, 2)
            }
            finally {
                $graphics.ReleaseHdc($dc)
            }
            if (-not $printed) {
                $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
            }
        }
        finally { $graphics.Dispose() }
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally { $bitmap.Dispose() }
}

function Invoke-Capture {
    if (-not $dotnet) {
        Add-Check 'CompanionTabsPreview build' $false 'No .NET SDK executable was found.'
        $risks.Add('The real-window preview could not be built because no dotnet SDK was available.')
        return
    }
    if (-not (Test-Path -LiteralPath $PreviewProject)) {
        Add-Check 'CompanionTabsPreview build' $false "Preview project not found: $PreviewProject"
        $risks.Add('No standalone WPF preview project is present; no actual desktop screenshot was captured.')
        return
    }

    $buildArgs = @('build', $PreviewProject, '-c', $Configuration, '--no-restore')
    if (-not $SkipBuild -and -not (Invoke-CheckedCommand 'CompanionTabsPreview build' $dotnet $buildArgs)) {
        $risks.Add('The preview project failed to build; screenshot capture was skipped.')
        return
    }
    Add-Check 'CompanionTabsPreview project' $true 'uses the production WPF window and a caller-owned temp WebView2 profile'

    $previewDll = Join-Path (Split-Path -Parent $PreviewProject) "bin\$Configuration\net8.0-windows\CompanionTabsPreview.dll"
    if (-not (Test-Path -LiteralPath $previewDll)) {
        Add-Check 'CompanionTabsPreview output' $false "Preview output not found: $previewDll"
        $risks.Add('Preview output is missing; screenshot capture was skipped.')
        return
    }

    # One preview process owns all requested tabs. It writes a capture from
    # the production WPF visual tree and the active WebView2 controller, so a
    # locked desktop cannot return an unrelated lock-screen image.
    $profile = Join-Path ([IO.Path]::GetTempPath()) "CoachBuild-companion-tabs-qa-$([Guid]::NewGuid().ToString('N'))"
    $readyFile = Join-Path $profile 'ready.txt'
    New-Item -ItemType Directory -Force -Path $profile | Out-Null
    $runDirectory = Join-Path $OutputDirectory ("native-" + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
    New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
    $tabArgument = $Tabs -join ','
    $intervalMilliseconds = [Math]::Max(500, $SettleMilliseconds)
    $captureError = -not $SkipError
    $captureCount = $Tabs.Count + $(if ($captureError) { 1 } else { 0 })
    $durationSeconds = [Math]::Max(120, [int][Math]::Ceiling(($intervalMilliseconds * [Math]::Max(1, $captureCount + $Tabs.Count)) / 1000) + 45)
    $arguments = @(
        $previewDll,
        '--profile', $profile,
        '--ready-file', $readyFile,
        '--tabs', $tabArgument,
        '--interval-ms', $intervalMilliseconds,
        '--duration', $durationSeconds,
        '--capture-dir', $runDirectory)
    if ($captureError) { $arguments += @('--error-tab', $ErrorTab) }
    $process = $null
    try {
        $process = Start-Process -FilePath $dotnet -ArgumentList $arguments -WorkingDirectory $repoRoot -PassThru
        $sessionState = Get-DesktopSessionState
        Add-Check 'desktop session state' $true (
            "locked=$($sessionState.locked); foreground=$($sessionState.foregroundProcess); " +
            'capture provenance is compositor-native, not a screen grab')
        $deadline = (Get-Date).AddSeconds($WindowTimeoutSeconds)
        do {
            Start-Sleep -Milliseconds 250
            $process.Refresh()
            $ready = Test-Path -LiteralPath $readyFile
            if ($ready -and $process.MainWindowHandle -ne [IntPtr]::Zero) { break }
        } while ((Get-Date) -lt $deadline -and -not $process.HasExited)

        if ($process.HasExited) {
            $readyText = if (Test-Path -LiteralPath $readyFile) { Get-Content -Raw -LiteralPath $readyFile } else { 'no ready file' }
            throw "preview exited with code $($process.ExitCode): $readyText"
        }
        if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'preview did not expose a WPF window handle before timeout' }

        foreach ($tab in $Tabs) {
            $markerPattern = "(?m)^tab=$([regex]::Escape($tab))(?:\s|$)"
            $markerDeadline = (Get-Date).AddSeconds($WindowTimeoutSeconds)
            do {
                Start-Sleep -Milliseconds 250
                $process.Refresh()
                $readyText = if (Test-Path -LiteralPath $readyFile) { Get-Content -Raw -LiteralPath $readyFile } else { '' }
                if ($readyText -match $markerPattern) { break }
                if ($process.HasExited) { throw "preview exited while selecting $tab (code $($process.ExitCode)): $readyText" }
            } while ((Get-Date) -lt $markerDeadline)

            if ($readyText -notmatch $markerPattern) {
                throw "preview did not select $tab before timeout"
            }
            $screenshot = Join-Path $runDirectory "companion-tabs-$tab.png"
            $screenshotDeadline = (Get-Date).AddSeconds($WindowTimeoutSeconds + 30)
            do {
                Start-Sleep -Milliseconds 250
                $process.Refresh()
                if ($process.HasExited) {
                    throw "preview exited while capturing $tab (code $($process.ExitCode)): $(Get-Content -Raw $readyFile)"
                }
                if (Test-Path -LiteralPath $screenshot) { break }
            } while ((Get-Date) -lt $screenshotDeadline)

            if (-not (Test-Path -LiteralPath $screenshot)) {
                throw "preview did not write the native compositor capture for $tab before timeout"
            }
            $metadata = Join-Path $runDirectory "companion-tabs-$tab.json"
            if (-not (Test-Path -LiteralPath $metadata)) {
                throw "preview wrote $screenshot without its native capture metadata"
            }
            $screenshotPaths.Add((Resolve-Path -LiteralPath $screenshot).Path)
            Add-Check "native composed screenshot: $tab" $true (
                "Captured $screenshot using WPF RenderTargetBitmap + WebView2 CapturePreviewAsync")
        }

        if ($captureError) {
            $errorMarker = "(?m)^error-tab=$([regex]::Escape($ErrorTab))(?:\s|$)"
            $errorDeadline = (Get-Date).AddSeconds($WindowTimeoutSeconds + 30)
            do {
                Start-Sleep -Milliseconds 250
                $process.Refresh()
                if ($process.HasExited) {
                    throw "preview exited while staging the $ErrorTab error state (code $($process.ExitCode)): $(Get-Content -Raw $readyFile)"
                }
                $readyText = if (Test-Path -LiteralPath $readyFile) { Get-Content -Raw -LiteralPath $readyFile } else { '' }
                $errorScreenshot = Join-Path $runDirectory "companion-tabs-$ErrorTab-error.png"
                if (($readyText -match $errorMarker) -and (Test-Path -LiteralPath $errorScreenshot)) { break }
            } while ((Get-Date) -lt $errorDeadline)

            if (-not ($readyText -match $errorMarker)) {
                throw "preview did not stage the $ErrorTab navigation error before timeout"
            }
            if (-not (Test-Path -LiteralPath $errorScreenshot)) {
                throw "preview did not write the native compositor error capture for $ErrorTab before timeout"
            }
            $errorMetadata = Join-Path $runDirectory "companion-tabs-$ErrorTab-error.json"
            if (-not (Test-Path -LiteralPath $errorMetadata)) {
                throw "preview wrote $errorScreenshot without its native capture metadata"
            }
            $screenshotPaths.Add((Resolve-Path -LiteralPath $errorScreenshot).Path)
            Add-Check "native composed screenshot: $ErrorTab error" $true (
                "Captured $errorScreenshot from the shipped WPF navigation-error state")
        }
    }
    catch {
        $message = $_.Exception.Message
        foreach ($tab in $Tabs) {
            if (-not @($checks | Where-Object { $_.name -eq "native composed screenshot: $tab" })) {
                Add-Check "native composed screenshot: $tab" $false $message
                $risks.Add("The $tab native compositor screenshot was not captured: $message")
            }
        }
        if ($captureError -and -not @($checks | Where-Object { $_.name -eq "native composed screenshot: $ErrorTab error" })) {
            Add-Check "native composed screenshot: $ErrorTab error" $false $message
            $risks.Add("The $ErrorTab navigation-error screenshot was not captured: $message")
        }
    }
    finally {
        if ($process -and -not $process.HasExited) {
            $process.CloseMainWindow() | Out-Null
            if (-not $process.WaitForExit(5000)) { $process.Kill() }
        }
        if ($process) { $process.Dispose() }
        if (-not $KeepProfiles) {
            # The path is generated above and never points at LOCALAPPDATA;
            # leave it when -KeepProfiles is requested for WebView2 triage.
            if (Test-Path -LiteralPath $profile) {
                Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

if ($Mode -in @('Audit', 'All')) {
    Invoke-SourceAudit
    Invoke-TestAudit
}
if ($Mode -in @('Capture', 'All')) {
    Invoke-Capture
}

$failed = @($checks | Where-Object { $_.status -eq 'fail' }).Count
$expectedScreenshots = $Tabs.Count + $(if ($SkipError) { 0 } else { 1 })
$summary = if ($failed -eq 0 -and ($Mode -notin @('Capture', 'All') -or $screenshotPaths.Count -eq $expectedScreenshots)) {
    'Companion tabs QA passed.'
}
else {
    'Companion tabs QA has failures or incomplete evidence.'
}

[pscustomobject]@{
    summary = $summary
    files = @($files)
    checks = @($checks)
    risks = @($risks)
    screenshotPaths = @($screenshotPaths)
    screenshots = @($screenshotPaths)
    bugs = @($risks)
    limitations = @(
        'The native compositor captures the WPF client visual tree and excludes the Win32 title-bar frame.'
        'WebView2 site pixels come from CoreWebView2.CapturePreviewAsync; no HTML mockup, screen grab, or browser DOM read is used.'
    )
    releaseNotes = @(
        'Run this script against a Release build before packaging.'
        'Capture mode constructs the production WebView2Window directly and never starts App.OnStartup, so no LCU bridge, tray updater, settings file, or HKCU startup entry is touched.'
        'Each tab run receives a unique profile under the OS temp directory; use -KeepProfiles for WebView2 diagnostics.'
        'A screenshot is evidence only when the PNG path is listed above; a source audit or HTML mockup does not count as a real-window capture.'
    )
} | ConvertTo-Json -Depth 8

if ($failed -gt 0) { exit 1 }
if ($Mode -in @('Capture', 'All') -and $screenshotPaths.Count -ne $expectedScreenshots) { exit 2 }
