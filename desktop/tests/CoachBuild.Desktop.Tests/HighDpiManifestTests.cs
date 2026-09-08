using System.Reflection;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// Per-monitor-v2 DPI awareness must be DECLARED, not asked for at runtime.
///
/// <para>WHY. At 192 DPI (3072x1920) the research window's whole WPF-drawn
/// surface painted blank white — tab strip, status bar, logo — around a
/// WebView2 child that painted perfectly, with the buttons still present and
/// clickable through UIA (screenshots <c>_evidence/live-2.1.0/01-04</c>,
/// 2026-09-08). The white bands landed exactly on the 56px chrome row and the
/// 35px status row, and the WebView2's HWND exactly on the content row, so both
/// the layout arithmetic and the child placement were right; what failed was
/// the composition of the WPF visual layer, and only at high DPI. The process
/// was asking for per-monitor-v2 by calling
/// <c>SetProcessDpiAwarenessContext</c> from <c>Main</c>, which WPF does not
/// support: it fixes its render target against the process awareness as it
/// starts up. The supported way is the application manifest, which sets the
/// awareness before any managed code runs. At 96 DPI the scale factor is 1 and
/// the mismatch costs nothing — which is exactly why this shipped.</para>
///
/// <para>These are source/artifact assertions, not a rendering test: this box
/// has no 192-DPI display and the built exe is never run here. They pin the
/// thing that was missing, so it cannot be dropped again by a csproj edit.</para>
/// </summary>
public sealed class HighDpiManifestTests
{
    [Fact]
    public void The_desktop_project_ships_an_application_manifest()
    {
        var csproj = ReadRepoFile("desktop", "src", "CoachBuild.Desktop", "CoachBuild.Desktop.csproj");
        // Control: the file is the project we mean.
        Assert.Contains("<UseWPF>true</UseWPF>", csproj, StringComparison.Ordinal);
        Assert.Contains("<ApplicationManifest>app.manifest</ApplicationManifest>", csproj, StringComparison.Ordinal);
    }

    [Fact]
    public void The_manifest_declares_per_monitor_v2_both_ways()
    {
        var manifest = ReadRepoFile("desktop", "src", "CoachBuild.Desktop", "app.manifest");
        // Control: it is a manifest at all.
        Assert.Contains("<assembly", manifest, StringComparison.Ordinal);
        Assert.Contains("<windowsSettings>", manifest, StringComparison.Ordinal);

        // The 2016 element for Windows 10+, and the 2005 one for the builds
        // that do not read it. Both must be present and must agree: declaring
        // only one leaves the other era on system-DPI.
        Assert.Contains("permonitorv2", manifest, StringComparison.Ordinal);
        Assert.Contains("<dpiAware", manifest, StringComparison.Ordinal);
        Assert.Contains("true/pm", manifest, StringComparison.Ordinal);
        Assert.DoesNotContain(">true<", manifest, StringComparison.Ordinal);
    }

    /// <summary>
    /// The runtime call stays as a fallback for a host that strips the
    /// manifest, but it must not be the only path — that is the state that
    /// produced the blank chrome.
    /// </summary>
    [Fact]
    public void The_runtime_call_is_documented_as_the_fallback_not_the_mechanism()
    {
        var program = ReadRepoFile("desktop", "src", "CoachBuild.Desktop", "Program.cs");
        Assert.Contains("SetProcessDpiAwarenessContext", program, StringComparison.Ordinal);
        Assert.Contains("app.manifest", program, StringComparison.Ordinal);
    }

    /// <summary>
    /// The shipped assembly really carries the manifest, so a build that
    /// silently dropped it fails here rather than at 192 DPI on the user's
    /// machine. Win32 resource type 24 (RT_MANIFEST) is what the loader reads.
    /// </summary>
    [Fact]
    public void The_built_assembly_embeds_a_win32_manifest_naming_permonitorv2()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "CoachBuild.Desktop.dll");
        Assert.True(File.Exists(path), $"control: {path} must exist next to the tests");

        // The manifest is embedded as a Win32 resource in the EXE, not the
        // managed dll, so read the app host next to it when present; either
        // way the assertion is on bytes that shipped, not on source.
        var exe = Path.Combine(AppContext.BaseDirectory, "CoachBuild.Desktop.exe");
        var target = File.Exists(exe) ? exe : path;
        var bytes = File.ReadAllBytes(target);
        // RT_MANIFEST resources are stored as UTF-8 XML.
        var text = System.Text.Encoding.UTF8.GetString(bytes);
        Assert.True(
            text.Contains("permonitorv2", StringComparison.OrdinalIgnoreCase),
            $"{Path.GetFileName(target)} carries no per-monitor-v2 manifest");
    }

    private static string ReadRepoFile(params string[] parts)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null &&
               !File.Exists(Path.Combine(directory.FullName, "desktop", "CoachBuild.Desktop.sln")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var path = Path.Combine([directory!.FullName, .. parts]);
        Assert.True(File.Exists(path), $"control: {path} must exist");
        return File.ReadAllText(path);
    }
}
