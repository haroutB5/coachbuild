[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$GitHubToken = $env:GITHUB_TOKEN,
    # Deliberately NOT defaulted here. Under Windows PowerShell 5.1 $PSScriptRoot
    # is EMPTY inside a param() block default, so `Join-Path $PSScriptRoot ...`
    # throws before the script does anything ("Cannot bind argument to parameter
    # 'Path' because it is an empty string") — hit for real cutting 1.0.17 on a
    # machine with no pwsh 7. The default is resolved in the body instead, exactly
    # as package.ps1 already does for the same parameter.
    [string]$OutputDirectory,
    [string]$Vpk = 'vpk',
    # Leave the GitHub release as a draft. Drafts are never served as `latest`,
    # so the in-app Velopack updater will not see the release until a human
    # publishes it by hand. Default is a published (non-draft) release.
    [switch]$Draft
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot '..\artifacts'
}
$packageScript = Join-Path $PSScriptRoot 'package.ps1'

# SAC smoke-gate (2026-09-08): Smart App Control's cloud verdict on a brand-new
# unsigned hash is effectively random — a build was blocked on 2.1.0 QA while a
# rebuild of the SAME commit ran fine. The app ships unsigned, so before
# uploading, prove the packaged binary actually LOADS on this machine by
# running its --self-test. A SAC block kills the process during assembly load
# (0xE0434352 / -532462766); self-test itself exits 0 (pass) or 1 (checks
# failed — still proves the hash loads). On a load failure, rebuild into a
# fresh subdirectory (a rebuild produces a new MVID/hash) and probe again.
$maxAttempts = 3
$attemptDir = $OutputDirectory
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    if ($attempt -gt 1) {
        $attemptDir = Join-Path $OutputDirectory "sac-retry-$attempt"
        Write-Host "SAC gate: rebuilding with a fresh hash into $attemptDir (attempt $attempt of $maxAttempts)"
    }
    & $packageScript -Version $Version -OutputDirectory $attemptDir -Vpk $Vpk
    if ($LASTEXITCODE -ne 0) { throw "Packaging failed with exit code $LASTEXITCODE" }

    $probeExe = Join-Path $attemptDir "publish-win-x64-$Version\CoachBuild.Desktop.exe"
    $probe = Start-Process -FilePath $probeExe -ArgumentList '--self-test' -PassThru -Wait -WindowStyle Hidden
    if ($probe.ExitCode -eq 0 -or $probe.ExitCode -eq 1) {
        if ($probe.ExitCode -eq 1) {
            Write-Warning 'SAC gate: binary loads but --self-test reported failures; continuing (hash is SAC-viable).'
        } else {
            Write-Host "SAC gate: packaged binary loads and self-tests clean (attempt $attempt)."
        }
        break
    }
    Write-Warning "SAC gate: packaged binary failed to load (exit $($probe.ExitCode)) - likely a Smart App Control per-hash block."
    if ($attempt -eq $maxAttempts) {
        throw "SAC gate: $maxAttempts consecutive builds failed to load; not publishing a build that dies on launch. Investigate before releasing."
    }
}
$OutputDirectory = $attemptDir

if ([string]::IsNullOrWhiteSpace($GitHubToken)) {
    throw 'Set GITHUB_TOKEN or pass -GitHubToken before publishing.'
}

$packageDirectory = (Resolve-Path (Join-Path $OutputDirectory "velopack-$Version")).Path
$feed = 'https://github.com/haroutB5/coachbuild-desktop-releases'

# This is intentionally the dedicated native feed. Do not substitute the
# legacy Electron repository: Velopack metadata and native artifacts must stay
# independently rollbackable.
# `--publish true` is required: without it vpk creates a draft release, GitHub
# never serves a draft as `latest`, and the updater silently never sees it.
$publishFlag = if ($Draft) { 'false' } else { 'true' }
& $Vpk upload github `
    --repoUrl $feed `
    --outputDir $packageDirectory `
    --token $GitHubToken `
    --publish $publishFlag

if ($LASTEXITCODE -ne 0) { throw "Velopack upload failed with exit code $LASTEXITCODE" }
if ($Draft) {
    Write-Host "Uploaded CoachBuild Desktop $Version to $feed as a DRAFT. It will not reach the updater until you publish it."
} else {
    Write-Host "Published CoachBuild Desktop $Version to $feed"
}
