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
& $packageScript -Version $Version -OutputDirectory $OutputDirectory -Vpk $Vpk
if ($LASTEXITCODE -ne 0) { throw "Packaging failed with exit code $LASTEXITCODE" }

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
