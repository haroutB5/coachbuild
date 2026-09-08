<#
.SYNOPSIS
  Dumps the companion window's tab chrome as text via UI Automation.

.DESCRIPTION
  Evidence for the chrome on a machine whose desktop session may be locked.
  PrintWindow returns only the WebView2 child surface there — every WPF-drawn
  band comes back blank — so a screenshot cannot show the tab strip. The
  automation tree can: it carries the real labels, enabled state, offer-bar
  visibility and status text that the strip is rendering from.

  It is evidence of STRUCTURE, not of pixels, and should be reported as such.
#>
[CmdletBinding()]
param([switch]$All)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$proc = Get-Process -Name 'CoachBuild.Desktop' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { throw 'CoachBuild.Desktop is not running.' }

$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)

$window = $null
foreach ($candidate in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)) {
    $probe = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'CompanionTabButton')
    if ($candidate.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $probe)) { $window = $candidate; break }
}
if (-not $window) { throw "No CoachBuild window carrying the tab chrome (pid $($proc.Id))." }

Write-Output "window: '$($window.Current.Name)'"

$interesting = @(
    'CompanionTabButton', 'UggTabButton', 'CoachlessTabButton', 'OpGgTabButton',
    'BackButton', 'ForwardButton', 'RefreshButton',
    'ZoomOutButton', 'ZoomInButton', 'ZoomText',
    'OfferBar', 'OfferHintText', 'UggOfferButton', 'CoachlessOfferButton',
    'StatusText'
)

foreach ($id in $interesting) {
    $c = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
    $e = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
    if (-not $e) { Write-Output ("{0,-22} <not present>" -f $id); continue }
    $cur = $e.Current
    $rect = $cur.BoundingRectangle
    # An offscreen element is how a "hidden" control still shows up in the tree;
    # report it so a collapsed offer bar is not read as a visible one.
    $vis = if ($cur.IsOffscreen) { 'hidden' } else { 'visible' }
    $enabled = if ($cur.IsEnabled) { 'enabled' } else { 'disabled' }
    Write-Output ("{0,-22} {1,-8} {2,-9} name='{3}' rect={4}x{5}" -f `
        $id, $vis, $enabled, $cur.Name, [int]$rect.Width, [int]$rect.Height)
}
