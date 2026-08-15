[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$GitHubToken = $env:GITHUB_TOKEN,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\artifacts'),
    [string]$Vpk = 'vpk',
    # Leave the GitHub release as a draft. Drafts are never served as `latest`,
    # so the in-app Velopack updater will not see the release until a human
    # publishes it by hand. Default is a published (non-draft) release.
    [switch]$Draft
)

$ErrorActionPreference = 'Stop'
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
