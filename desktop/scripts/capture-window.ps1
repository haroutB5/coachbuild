<#
.SYNOPSIS
  Captures the CoachBuild companion window to a PNG.

.DESCRIPTION
  Used to evidence desktop UI states on a machine that cannot run the game.
  It captures the SCREEN RECTANGLE the window occupies rather than asking the
  window to render itself: WebView2 is an out-of-process HwndHost, so
  PrintWindow / VisualBrush return the WPF chrome with a HOLE where the browser
  should be. A screen-rectangle grab is the only method that includes the page.

  The window is brought to the foreground first, and the capture fails loudly
  when the window cannot be found or is minimised — a blank or stale PNG that
  gets pasted into a report as evidence is worse than no PNG.

.PARAMETER Out
  Destination PNG path. Parent directories are created.

.PARAMETER TitleLike
  Substring of the target window title.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$TitleLike = 'CoachBuild',
    [int]$SettleMs = 900
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);

    // Windows refuses SetForegroundWindow from a process that does not own the
    // foreground. Borrowing the current foreground thread's input queue is the
    // documented way for a tool like this to get the window up; without it the
    // capture silently grabs whatever else is on screen.
    public static void ForceForeground(IntPtr h) {
        // Synthesising an ALT release lifts the foreground lock for this
        // thread; without it SetForegroundWindow is a no-op that returns true.
        keybd_event(0x12, 0, 0, IntPtr.Zero);
        keybd_event(0x12, 0, 0x0002, IntPtr.Zero);
        uint self = GetCurrentThreadId();
        uint other = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        if (other != 0 && other != self) AttachThreadInput(other, self, true);
        SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0002 | 0x0001); // TOPMOST, no move/size
        SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0002 | 0x0001); // back to NOTOPMOST
        BringWindowToTop(h);
        SetForegroundWindow(h);
        if (other != 0 && other != self) AttachThreadInput(other, self, false);
    }
}
'@

$proc = Get-Process -Name 'CoachBuild.Desktop' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$TitleLike*" } |
    Select-Object -First 1

if (-not $proc) {
    throw "No CoachBuild.Desktop window whose title contains '$TitleLike'. Windows found: " +
        ((Get-Process -Name 'CoachBuild.Desktop' -ErrorAction SilentlyContinue |
            ForEach-Object { "'$($_.MainWindowTitle)'" }) -join ', ')
}

$h = $proc.MainWindowHandle
if ([Win]::IsIconic($h)) { [void][Win]::ShowWindow($h, 9) }
[Win]::ForceForeground($h)
Start-Sleep -Milliseconds $SettleMs

$front = [Win]::GetForegroundWindow()
$isForeground = ($front -eq $h)

# The DWM extended frame excludes the invisible resize border Win32 reports.
$r = New-Object Win+RECT
if ([Win]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) {
    [void][Win]::GetWindowRect($h, [ref]$r)
}

$w = $r.R - $r.L
$hgt = $r.B - $r.T
if ($w -le 0 -or $hgt -le 0) { throw "Window rect is empty ($w x $hgt); refusing to write a blank capture." }

# How much of the image is not one flat colour. A window that has not painted,
# or a screen grab of an empty desktop, lands near zero — and that is exactly
# the picture that gets pasted into a report as though it proved something.
function Get-Variety([System.Drawing.Bitmap]$b) {
    $seen = New-Object 'System.Collections.Generic.HashSet[int]'
    for ($y = 0; $y -lt $b.Height; $y += 17) {
        for ($x = 0; $x -lt $b.Width; $x += 17) {
            [void]$seen.Add($b.GetPixel($x, $y).ToArgb())
        }
    }
    return $seen.Count
}

function Save-Capture([System.Drawing.Bitmap]$b, [string]$path) {
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $b.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

# Two methods, best result wins.
#   PrintWindow(PW_RENDERFULLCONTENT) does not need the window in front, which
#   matters because Windows refuses foreground to a tool launched from a
#   background console. It renders DirectComposition content, so it usually
#   includes the WebView2 surface.
#   CopyFromScreen is the fallback and is only trustworthy when the window is
#   actually in front.
$candidates = @()

$pw = New-Object System.Drawing.Bitmap $w, $hgt
$gpw = [System.Drawing.Graphics]::FromImage($pw)
$hdc = $gpw.GetHdc()
$ok = [Win]::PrintWindow($h, $hdc, 2)
$gpw.ReleaseHdc($hdc)
$gpw.Dispose()
if ($ok) { $candidates += ,@('PrintWindow', $pw, (Get-Variety $pw)) }

# CopyFromScreen is offered ONLY when this window truly holds the foreground.
#
# This is not belt-and-braces, it is the bug this script already shipped once:
# on a LOCKED workstation the grab returned the Windows lock screen — a photo,
# so the "is it blank?" heuristic below scored it 9,200 distinct colours and
# happily declared it a good capture of the app. A picture of a leopard passed
# a blankness test. Richness of content says nothing about WHICH content, so
# the only sound gate is provenance, not statistics.
if ($isForeground) {
    $sc = New-Object System.Drawing.Bitmap $w, $hgt
    $gsc = [System.Drawing.Graphics]::FromImage($sc)
    $gsc.CopyFromScreen($r.L, $r.T, 0, 0, $sc.Size)
    $gsc.Dispose()
    $candidates += ,@('CopyFromScreen', $sc, (Get-Variety $sc))
}

if ($candidates.Count -eq 0) { throw "Both capture methods failed for handle $h." }

$best = $candidates | Sort-Object { $_[2] } -Descending | Select-Object -First 1
$method = $best[0]; $bmp = $best[1]; $variety = $best[2]

if ($variety -lt 12) {
    throw "Capture via $method has only $variety distinct sampled colours - the window has not painted. Refusing to save a blank screenshot as evidence."
}

Save-Capture $bmp $Out
foreach ($c in $candidates) { $c[1].Dispose() }

Write-Output "$Out  ($w x $hgt)  via=$method  colours=$variety  foreground=$isForeground  title='$($proc.MainWindowTitle)'"
