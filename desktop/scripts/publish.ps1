[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$GitHubToken = $env:GITHUB_TOKEN,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\artifacts'),
    [string]$Vpk = 'vpk'
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
& $Vpk upload github `
    --repoUrl $feed `
    --outputDir $packageDirectory `
    --token $GitHubToken

if ($LASTEXITCODE -ne 0) { throw "Velopack upload failed with exit code $LASTEXITCODE" }
Write-Host "Published CoachBuild Desktop $Version to $feed"
