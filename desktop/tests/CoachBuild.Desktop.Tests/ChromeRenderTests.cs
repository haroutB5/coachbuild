using System.Globalization;
using System.Text.RegularExpressions;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The blank-white-chrome fault (2.1.0, 192 DPI, twice on 2026-09-08) and the
/// two things 2.1.1 does about it: render the WPF chrome in software by
/// default, and keep every Grid row of the research window explicitly painted
/// so a white pixel can never be something the XAML asked for.
///
/// <para>The window itself cannot be constructed here — it needs an STA
/// dispatcher and a WebView2 environment — so what is pinned is the DECISION
/// and the MARKUP, which is where both halves of the fix actually live.</para>
/// </summary>
public sealed class ChromeRenderTests
{
    private const string WindowMarkup = "Web/WebView2Window.xaml";
    private const string WindowSource = "Web/WebView2Window.xaml.cs";
    private const string ProgramSource = "Program.cs";

    // -- The render mode decision ----------------------------------------------

    /// <summary>
    /// Software is the DEFAULT, not an opt-in. The failure mode is an
    /// unreadable window, and the cost here is close to nothing: WPF paints
    /// only chrome, every page pixel belongs to the WebView2's own compositor,
    /// and the overlay is already a layered (software) window.
    /// </summary>
    [Fact]
    public void The_process_renders_its_chrome_in_software_by_default()
    {
        Assert.Equal(ChromeRenderMode.SoftwareOnly, ChromeRenderPolicy.Decide(gpuRenderRequested: false));
        Assert.Equal(1, ChromeRenderPolicy.ToProcessRenderMode(ChromeRenderMode.SoftwareOnly));
    }

    /// <summary>Reversible without a new build.</summary>
    [Fact]
    public void Gpu_render_restores_the_hardware_path()
    {
        Assert.Equal(ChromeRenderMode.Hardware, ChromeRenderPolicy.Decide(gpuRenderRequested: true));
        Assert.Equal(0, ChromeRenderPolicy.ToProcessRenderMode(ChromeRenderMode.Hardware));
    }

    [Theory]
    [InlineData("--gpu-render")]
    [InlineData("--GPU-Render")]
    public void The_gpu_render_flag_is_parsed(string flag)
    {
        Assert.True(CommandLineOptions.Parse([flag]).GpuRender);
    }

    [Fact]
    public void No_flag_means_no_gpu_render()
    {
        Assert.False(CommandLineOptions.Parse([]).GpuRender);
        Assert.False(CommandLineOptions.Parse(["--autostart"]).GpuRender);
        // Control: the flag does not disturb its neighbours.
        var both = CommandLineOptions.Parse(["--autostart", "--gpu-render"]);
        Assert.True(both.GpuRender);
        Assert.True(both.Autostart);
    }

    /// <summary>
    /// ORDER IS LOAD-BEARING. WPF pins the process render mode when it brings
    /// up its media context, so a ProcessRenderMode set after the first Window
    /// (or after App) is silently ignored — the same trap the DPI awareness
    /// fell into in 2.1.0, where setting it from managed code after startup
    /// left composition and window disagreeing. Asserted on the source because
    /// there is no runtime observation that distinguishes "set too late" from
    /// "set and honoured".
    /// </summary>
    [Fact]
    public void The_render_mode_is_set_before_the_app_is_constructed()
    {
        var source = ReadSource(ProgramSource);
        var applied = source.IndexOf("ApplyChromeRenderMode(options)", StringComparison.Ordinal);
        var appBuilt = source.IndexOf("new App()", StringComparison.Ordinal);
        Assert.True(applied >= 0, "control: Main must apply the render mode");
        Assert.True(appBuilt >= 0, "control: Main must construct the App");
        Assert.True(applied < appBuilt, "the render mode must be set before the App exists");
        Assert.Contains("RenderOptions.ProcessRenderMode", source, StringComparison.Ordinal);
        // One place decides. A second assignment is how the two halves drift.
        Assert.Single(Regex.Matches(source, @"ProcessRenderMode\s*="));
    }

    /// <summary>
    /// The first-paint repair: the regions that painted correctly during the
    /// fault were exactly the ones something invalidated after first paint, so
    /// the window forces one re-render of its chrome once content is up.
    /// </summary>
    [Fact]
    public void The_window_repaints_its_chrome_after_the_first_frame()
    {
        var source = ReadSource(WindowSource);
        Assert.Contains("OnContentRendered", source, StringComparison.Ordinal);
        foreach (var element in new[] { "ChromeRow", "OfferBar", "ContentHost", "StatusRow" })
            Assert.Contains(element, source, StringComparison.Ordinal);
    }

    // -- The markup invariant ---------------------------------------------------

    /// <summary>
    /// EVERY Grid row of the research window is covered by an element that
    /// declares its own Background. A row left bare would show the window's
    /// backing surface, which is precisely the white the fault produced — so a
    /// future refactor that drops a background must fail here rather than in a
    /// screenshot from a real game.
    ///
    /// <para>This also disposes of the "leftover white row" hypothesis for the
    /// 2.1.0 fault: there is no such row, and the assertion below is what keeps
    /// that true.</para>
    /// </summary>
    [Fact]
    public void Every_chrome_row_declares_its_own_background()
    {
        var markup = ReadSource(WindowMarkup);
        var rows = Regex.Matches(markup, "<RowDefinition\\b").Count;
        Assert.Equal(4, rows);

        for (var row = 0; row < rows; row++)
        {
            // The element that occupies this row, and the 400 characters of
            // its opening tag, must carry a Background.
            var placed = Regex.Match(markup, $"Grid\\.Row=\"{row}\"");
            Assert.True(placed.Success, $"no element is placed in row {row}");
            var tagStart = markup.LastIndexOf('<', placed.Index);
            var tagEnd = markup.IndexOf('>', placed.Index);
            var tag = markup[tagStart..tagEnd];
            Assert.Contains("Background=", tag, StringComparison.Ordinal);
        }

        // The root Grid too: it is what shows through a collapsed row.
        Assert.Contains(
            "<Grid Background=\"{StaticResource CanvasBrush}\">", markup, StringComparison.Ordinal);
    }

    /// <summary>
    /// Every ROW background, and the root Grid's, resolves to a DARK colour —
    /// with one documented exception, row 2's <c>SiteCanvasBrush</c> (#F4F7FA),
    /// which sits behind the WebView2 so a loading site page does not flash
    /// dark, and which was never visible during the fault because the landing
    /// state (#081A2A) covers it.
    ///
    /// <para>Scoped to backgrounds on purpose: foreground brushes are light by
    /// design (that is what makes the text readable), so sweeping every colour
    /// in the file would assert nothing about what fills the chrome. This is
    /// the claim that matters — a white band on screen is never a fill this
    /// markup asked for, so it is an unpresented surface.</para>
    /// </summary>
    [Fact]
    public void Every_row_background_is_dark_except_the_documented_site_canvas()
    {
        var markup = ReadSource(WindowMarkup);
        var brushes = Regex.Matches(
                markup, "<SolidColorBrush\\s+x:Key=\"(?<key>\\w+)\"\\s+Color=\"(?<colour>#[0-9A-Fa-f]{6,8})\"")
            .ToDictionary(m => m.Groups["key"].Value, m => m.Groups["colour"].Value, StringComparer.Ordinal);
        Assert.NotEmpty(brushes);

        var rowColours = new List<string>();
        for (var row = 0; row < 4; row++)
        {
            var placed = Regex.Match(markup, $"Grid\\.Row=\"{row}\"");
            var tag = markup[markup.LastIndexOf('<', placed.Index)..markup.IndexOf('>', placed.Index)];
            rowColours.Add(Resolve(tag, brushes));
        }

        // Row 2 is the content host; every other row is chrome and must be dark.
        Assert.False(IsLight(rowColours[0]), $"chrome row is {rowColours[0]}");
        Assert.False(IsLight(rowColours[1]), $"offer bar is {rowColours[1]}");
        Assert.Equal("#F4F7FA", rowColours[2]);
        Assert.False(IsLight(rowColours[3]), $"status bar is {rowColours[3]}");

        // The root Grid shows through a collapsed row, so it counts too.
        Assert.False(IsLight(brushes["CanvasBrush"]));
        // And the landing state is what actually covers row 2 on screen.
        Assert.Contains("Background=\"#081A2A\"", markup, StringComparison.Ordinal);

        // Named white in any spelling is out.
        Assert.DoesNotContain("Background=\"White\"", markup, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("#FFFFFF", markup, StringComparison.OrdinalIgnoreCase);

        // Control: the luminance probe can say "light" at all, or the three
        // dark assertions above are vacuous.
        Assert.True(IsLight("#F4F7FA"));
        Assert.False(IsLight("#0D1C2E"));

        static string Resolve(string tag, Dictionary<string, string> brushes)
        {
            var literal = Regex.Match(tag, "Background=\"(?<colour>#[0-9A-Fa-f]{6,8})\"");
            if (literal.Success) return literal.Groups["colour"].Value;
            var resource = Regex.Match(tag, "Background=\"\\{StaticResource (?<key>\\w+)\\}\"");
            Assert.True(resource.Success, $"row tag declares no resolvable Background: {tag}");
            return brushes[resource.Groups["key"].Value];
        }
    }

    /// <summary>Relative luminance over 0.5 on the sRGB channels, ignoring alpha.</summary>
    private static bool IsLight(string hex)
    {
        var digits = hex[1..];
        if (digits.Length == 8) digits = digits[2..];
        var r = Channel(digits[..2]);
        var g = Channel(digits[2..4]);
        var b = Channel(digits[4..6]);
        return ((0.2126 * r) + (0.7152 * g) + (0.0722 * b)) > 0.5;

        static double Channel(string pair) =>
            int.Parse(pair, NumberStyles.HexNumber, CultureInfo.InvariantCulture) / 255.0;
    }

    private static string ReadSource(string relativePath)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(
                directory.FullName,
                "src",
                "CoachBuild.Desktop",
                relativePath.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(candidate)) return File.ReadAllText(candidate);
            directory = directory.Parent;
        }

        throw new FileNotFoundException(
            $"Could not locate {relativePath} above {AppContext.BaseDirectory}.");
    }
}
