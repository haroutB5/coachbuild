<#
.SYNOPSIS
  Runs BOTH desktop test suites explicitly and fails unless both report.

.DESCRIPTION
  WHY THIS EXISTS (2026-09-10).

  `dotnet test desktop/CoachBuild.Desktop.sln -c Release` has been observed
  running only ONE of the solution's two test projects and still exiting 0 —
  a run on commit 28b68eb reported CoachBuild.Desktop.Tests (655) and never
  touched CoachBuild.Core.Tests (577), which passes when invoked directly.
  The previously documented cause of a vanishing suite was a compile error in
  that project; that is NOT the case here, so the real cause is undiagnosed.

  A gate that can silently drop half its coverage while going green is worse
  than no gate, because it launders a partial run into a release decision.
  This script removes the ambiguity: it invokes each test project BY PATH and
  requires a "Passed!" line from each. Missing output for either project is a
  failure, not a pass.

  Use this instead of the bare solution-level command before packaging.
#>
[CmdletBinding()]
param(
    [string]$Configuration = 'Release',
    [string]$Dotnet
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Dotnet)) {
    # The SDK is NOT the copy on PATH (that one carries runtimes only).
    $candidate = Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\dotnet.exe'
    $Dotnet = if (Test-Path -LiteralPath $candidate) { $candidate } else { 'dotnet' }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$projects = @(
    'desktop\tests\CoachBuild.Core.Tests\CoachBuild.Core.Tests.csproj',
    'desktop\tests\CoachBuild.Desktop.Tests\CoachBuild.Desktop.Tests.csproj'
)

$failed = @()
foreach ($relative in $projects) {
    $project = Join-Path $repoRoot $relative
    if (-not (Test-Path -LiteralPath $project)) {
        Write-Warning "gate: MISSING project $relative"
        $failed += "$relative (missing)"
        continue
    }

    Write-Host "gate: running $relative"
    $output = & $Dotnet test $project -c $Configuration 2>&1
    $exitCode = $LASTEXITCODE
    $passed = $output | Select-String -Pattern '^Passed!' -Quiet
    $summary = ($output | Select-String -Pattern 'Passed!|Failed!' | Select-Object -First 1)

    if ($passed -and $exitCode -eq 0) {
        Write-Host "  $summary"
    } else {
        # No "Passed!" line at all is the exact silent-skip shape this guards.
        Write-Warning "  suite did not pass cleanly: $relative (exit $exitCode, Passed! present: $passed)"
        $output | Select-Object -Last 15 | ForEach-Object { Write-Host "    $_" }
        $failed += $relative
    }
}

if ($failed.Count -gt 0) {
    throw "gate FAILED: $($failed -join ', '). Every suite must report Passed! -- a missing suite is never a pass."
}

Write-Host 'gate: both suites reported Passed!'
