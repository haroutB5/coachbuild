using System.Diagnostics;

namespace CoachBuild.Core;

/// <summary>
/// v1.7.0 hard-kill fallback, C# side. Mirrors Test-BrowserProcessRunning in
/// public/companion.ps1 (same process-name list, same fail-open contract):
/// <c>pagehide</c> covers a closed tab and an orderly browser exit, but not a
/// task-kill, a crash, or a sign-out. Without this those cases keep a stale
/// attach stamp alive for the full attach window and suppress the open the
/// user is waiting for.
///
/// Only ever used to make an attached kind count as DETACHED, never the other
/// way round — a false negative costs one redundant window, and it cannot
/// resurrect the tab-spam bug. An enumeration failure returns <c>true</c>
/// (trust the stamp), exactly like the PowerShell side.
/// </summary>
public static class BrowserProcessProbe
{
    public static readonly string[] KnownBrowserProcessNames =
    [
        "chrome", "msedge", "firefox", "brave", "opera", "opera_gx", "vivaldi",
        "chromium", "thorium", "librewolf", "waterfox", "floorp", "arc", "zen", "iexplore",
    ];

    public static bool IsBrowserRunning()
    {
        try
        {
            foreach (var name in KnownBrowserProcessNames)
            {
                var found = Process.GetProcessesByName(name);
                try
                {
                    if (found.Length > 0) return true;
                }
                finally
                {
                    foreach (var process in found) process.Dispose();
                }
            }
            return false;
        }
        catch
        {
            // Never let a process-enumeration failure decide anything.
            return true;
        }
    }
}
