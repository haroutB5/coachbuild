[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$OutputDirectory,
    [string]$Runtime = 'win-x64',
    [string]$Vpk = 'vpk',
    [switch]$SkipWebView2Bootstrapper
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot '..\artifacts'
}
$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$publishDirectory = Join-Path $OutputDirectory "publish-$Runtime-$Version"
$packageDirectory = Join-Path $OutputDirectory "velopack-$Version"

$parsedVersion = $null
if (-not [System.Version]::TryParse($Version, [ref]$parsedVersion)) {
    throw "Version must be a dotted numeric version accepted by Velopack: $Version"
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $publishDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $packageDirectory | Out-Null

$project = Join-Path $desktopRoot 'src\CoachBuild.Desktop\CoachBuild.Desktop.csproj'
dotnet publish $project --configuration $Configuration --runtime $Runtime --self-contained false --output $publishDirectory

$iconPath = Join-Path $publishDirectory 'Assets\tray-icon.ico'
if (-not (Test-Path $iconPath)) {
    throw "Application icon was not included in publish output: $iconPath"
}

$bootstrapper = Join-Path $publishDirectory 'WebView2\MicrosoftEdgeWebview2Setup.exe'
if (-not (Test-Path $bootstrapper)) {
    if ($SkipWebView2Bootstrapper) {
        Write-Warning 'WebView2 Evergreen bootstrapper download was skipped; clean-profile installs will require the repair action.'
    }
    else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bootstrapper) | Out-Null
        try {
            Invoke-WebRequest `
                -Uri 'https://go.microsoft.com/fwlink/?linkid=2124703' `
                -OutFile $bootstrapper `
                -UseBasicParsing
        }
        catch {
            throw "Could not download the Evergreen WebView2 bootstrapper: $($_.Exception.Message)"
        }
    }
}

& $Vpk pack `
    --packId CoachBuild.Desktop `
    --packVersion $Version `
    --packDir $publishDirectory `
    --mainExe CoachBuild.Desktop.exe `
    --packTitle CoachBuild `
    --outputDir $packageDirectory `
    --icon $iconPath `
    --delta BestSpeed

if ($LASTEXITCODE -ne 0) { throw "Velopack pack failed with exit code $LASTEXITCODE" }

Write-Host "Created per-user Velopack artifacts in $packageDirectory"
Write-Host 'Install root: %LOCALAPPDATA%\CoachBuild.Desktop (Velopack per-user root: Update.exe, current\, packages\)'
Write-Host 'Data root:    %LOCALAPPDATA%\CoachBuild (companion.log, settings)'
Write-Host 'Feed: https://github.com/haroutB5/coachbuild-desktop-releases/releases/latest/download'
