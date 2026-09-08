<#
.SYNOPSIS
  Invokes a named control in the CoachBuild companion window via UI Automation.

.DESCRIPTION
  Used to exercise the tab chrome on a machine where the desktop session may be
  locked. UI Automation's InvokePattern does not require input focus or a
  visible desktop, so it drives the same code path a real click does without
  depending on the foreground window.

  WPF derives AutomationId from x:Name, so the ids here are the x:Name values in
  WebView2Window.xaml.

  It fails loudly when the control cannot be found. A driver that silently does
  nothing produces a screenshot of the previous state, which is indistinguishable
  from a feature that does not work.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$AutomationId,
    [int]$SettleMs = 2500
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$deadline = (Get-Date).AddSeconds(20)

# Matched on the owning PROCESS, not the window class: WPF window classes are
# generated ("HwndWrapper[app;;guid]") and the title changes with the tab.
$proc = Get-Process -Name 'CoachBuild.Desktop' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { throw 'CoachBuild.Desktop is not running.' }

$window = $null
while (-not $window -and (Get-Date) -lt $deadline) {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
    foreach ($candidate in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)) {
        # The tray app also owns an invisible overlay window; the companion is
        # the one carrying the tab buttons.
        $probe = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'CompanionTabButton')
        if ($candidate.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $probe)) {
            $window = $candidate
            break
        }
    }
    if (-not $window) { Start-Sleep -Milliseconds 400 }
}
if (-not $window) { throw "No CoachBuild window carrying the tab chrome was found (pid $($proc.Id))." }

$idCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $AutomationId)
$element = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $idCondition)
if (-not $element) {
    $all = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition) |
        ForEach-Object { $_.Current.AutomationId } | Where-Object { $_ }
    throw "No control with AutomationId '$AutomationId'. Present: $($all -join ', ')"
}

if (-not $element.Current.IsEnabled) { throw "Control '$AutomationId' is disabled; refusing to claim it was invoked." }

$invoke = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
Start-Sleep -Milliseconds $SettleMs

Write-Output "invoked '$AutomationId' (name='$($element.Current.Name)')"
