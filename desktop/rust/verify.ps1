param([switch]$NativeTests)
$ErrorActionPreference = 'Stop'
$rustRoot = $PSScriptRoot
$cargoExe = Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe'
$dotnetExe = Join-Path $env:LOCALAPPDATA 'Microsoft/dotnet/dotnet.exe'
$manifest = Join-Path $rustRoot 'coachbuild-core/Cargo.toml'
$evidence = Join-Path $rustRoot 'evidence'
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
function Invoke-CheckedHeavy([string]$Name, [string]$Command) {
    $ErrorActionPreference = 'Continue' # Native stderr may carry normal compiler progress.
    $lines = New-Object 'System.Collections.Generic.List[string]'
    & powershell -NoProfile -ExecutionPolicy Bypass -File C:/Claude/AI/dev-team/tools/heavy-job.ps1 -Label 'optimizer coachbuild-core C:/Claude/AI/coachbuild' -WorkDir C:/Claude/AI/coachbuild -Command ($Command + ' 2>&1') | ForEach-Object { $lines.Add([string]$_); Write-Output $_ }
    $resultCode = $LASTEXITCODE
    [IO.File]::WriteAllLines((Join-Path $evidence ($Name + '.txt')), $lines, (New-Object Text.UTF8Encoding($false)))
    if ($resultCode -ne 0) { throw "$Name failed with exit $resultCode" }
}
Invoke-CheckedHeavy 'oracle-build' ('"{0}" build "{1}" --nologo --verbosity quiet' -f $dotnetExe,(Join-Path $rustRoot 'oracle/MergeOracle.csproj'))
Invoke-CheckedHeavy 'oracle-verify' ('node "{0}" verify "{1}"' -f (Join-Path $rustRoot 'parity.cjs'),$dotnetExe)
Invoke-CheckedHeavy 'native-build' ('"{0}" build --locked --manifest-path "{1}"' -f $cargoExe,$manifest)
Invoke-CheckedHeavy 'native-tests-compile' ('"{0}" test --locked --no-run --manifest-path "{1}"' -f $cargoExe,$manifest)
if ($NativeTests) {
    Invoke-CheckedHeavy 'native-tests' ('"{0}" test --locked --manifest-path "{1}"' -f $cargoExe,$manifest)
} else {
    $previousRunner = $env:CARGO_TARGET_WASM32_WASIP1_RUNNER
    if ($rustRoot -match '\s') { throw 'Use a checkout path without spaces for the Cargo runner.' }
    $env:CARGO_TARGET_WASM32_WASIP1_RUNNER = 'node ' + (Join-Path $rustRoot 'run-wasi.cjs')
    try {
        Invoke-CheckedHeavy 'wasi-tests' ('"{0}" test --locked --target wasm32-wasip1 --manifest-path "{1}"' -f $cargoExe,$manifest)
        Invoke-CheckedHeavy 'wasi-cli-build' ('"{0}" build --locked --target wasm32-wasip1 --manifest-path "{1}"' -f $cargoExe,$manifest)
        Invoke-CheckedHeavy 'cli-check' ('node "{0}"' -f (Join-Path $rustRoot 'check-cli.cjs'))
    } finally {
        $env:CARGO_TARGET_WASM32_WASIP1_RUNNER = $previousRunner
    }
}
