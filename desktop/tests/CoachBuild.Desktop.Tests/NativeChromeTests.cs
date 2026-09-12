using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Markup;
using System.Windows.Media.Imaging;
using CoachBuild.Desktop.Web;
using Xunit;
using Xunit.Abstractions;

// Fully qualified below: WinForms is enabled on this project, so the implicit
// System.Drawing / System.Windows.Forms usings make bare WPF names ambiguous.
using WpfBrush = System.Windows.Media.Brush;
using WpfBrushes = System.Windows.Media.Brushes;
using WpfButton = System.Windows.Controls.Button;
using WpfElement = System.Windows.FrameworkElement;
using WpfFontWeights = System.Windows.FontWeights;
using WpfGrid = System.Windows.Controls.Grid;
using WpfImage = System.Windows.Controls.Image;
using WpfPanel = System.Windows.Controls.Panel;
using WpfPixelFormats = System.Windows.Media.PixelFormats;
using WpfPoint = System.Windows.Point;
using WpfRect = System.Windows.Rect;
using WpfRenderTargetBitmap = System.Windows.Media.Imaging.RenderTargetBitmap;
using WpfSize = System.Windows.Size;
using WpfTextBlock = System.Windows.Controls.TextBlock;
using WpfVisibility = System.Windows.Visibility;
using WpfWindow = System.Windows.Window;
using WpfXamlReader = System.Windows.Markup.XamlReader;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The 2.5.0 native chrome: custom 54px title bar and 44px footer,
/// pixel-matched to the 1586x992 mocks.
/// </summary>
public sealed class NativeChromeTests
{
    private const string WindowMarkup = "Web/WebView2Window.xaml";
    private const string WindowSource = "Web/WebView2Window.xaml.cs";

    private readonly ITestOutputHelper _output;

    public NativeChromeTests(ITestOutputHelper output)
    {
        _output = output;
    }

    // -- Markup pins ----------------------------------------------------------

    [Fact]
    public void The_window_uses_custom_chrome_with_a_54px_caption()
    {
        var markup = ReadSource(WindowMarkup);
        Assert.Contains("Title=\"CoachBuild\"", markup, StringComparison.Ordinal);
        Assert.DoesNotContain("CoachBuild  •  Research", markup, StringComparison.Ordinal);
        Assert.Contains("WindowStyle=\"None\"", markup, StringComparison.Ordinal);
        Assert.Contains("CaptionHeight=\"54\"", markup, StringComparison.Ordinal);
        Assert.Contains("ResizeBorderThickness=\"6\"", markup, StringComparison.Ordinal);
        Assert.Contains("GlassFrameThickness=\"0\"", markup, StringComparison.Ordinal);
        Assert.Contains("UseAeroCaptionButtons=\"False\"", markup, StringComparison.Ordinal);
        Assert.Contains("<RowDefinition Height=\"54\" />", markup, StringComparison.Ordinal);
        Assert.Contains("<RowDefinition Height=\"44\" />", markup, StringComparison.Ordinal);
    }

    [Fact]
    public void The_chrome_row_has_the_spec_elements_and_no_legacy_ones()
    {
        var markup = ReadSource(WindowMarkup);
        foreach (var name in new[]
        {
            "BrandLogo", "BrandText", "ChromeDivider",
            "BackButton", "ForwardButton", "RefreshButton",
            "CompanionTabButton", "UggTabButton", "CoachlessTabButton", "OpGgTabButton",
            "CompanionDiamond", "UggDiamond", "CoachlessDiamond", "OpGgDiamond",
            "MinimizeButton", "MaximizeButton", "MaximizeGlyph", "CloseButton",
        })
        {
            Assert.Contains($"x:Name=\"{name}\"", markup, StringComparison.Ordinal);
        }

        // The tray gem is the logo, rendered at 32px.
        Assert.Contains("Source=\"pack://application:,,,/Assets/tray-icon.ico\"", markup, StringComparison.Ordinal);
        // Caption glyphs: minimise / maximise(+restore in code) / close.
        Assert.Contains("&#xE921;", markup, StringComparison.Ordinal);
        Assert.Contains("&#xE922;", markup, StringComparison.Ordinal);
        Assert.Contains("&#xE8BB;", markup, StringComparison.Ordinal);
        Assert.Contains("\"\\uE923\"", ReadSource(WindowSource), StringComparison.Ordinal);

        // Gone with the old chrome: the COACH/BUILD wordmark, the star tab
        // prefix, the italic op.gg subscript, and the state label the pill
        // replaces.
        Assert.DoesNotContain("TabStateText", markup, StringComparison.Ordinal);
        Assert.DoesNotContain("COACH", markup, StringComparison.Ordinal);
        Assert.DoesNotContain("\u2726", markup, StringComparison.Ordinal);
        Assert.DoesNotContain("FontStyle=\"Italic\"", markup, StringComparison.Ordinal);
        Assert.Contains("MyStats op.gg", markup, StringComparison.Ordinal);
    }

    [Fact]
    public void The_footer_has_the_live_setup_link_version_and_profiles_note()
    {
        var markup = ReadSource(WindowMarkup);
        foreach (var name in new[]
        {
            "LiveSetupLink", "FooterVersionText", "StatusText",
            "ProfilesButton", "ProfilesPopup",
        })
        {
            Assert.Contains($"x:Name=\"{name}\"", markup, StringComparison.Ordinal);
        }

        Assert.Contains("&#xE713;", markup, StringComparison.Ordinal);
        Assert.Contains("Separate site profiles", markup, StringComparison.Ordinal);
        Assert.Contains(
            "Each site tab keeps its own sign-in, cookies and history. Nothing is shared between tabs or with your normal browser.",
            markup,
            StringComparison.Ordinal);
        Assert.DoesNotContain("Manual browsing", markup, StringComparison.Ordinal);

        // The footer note starts collapsed: an idle "Ready" hides next to the
        // version (see SetStatusText).
        Assert.Contains("x:Name=\"StatusText\"", markup, StringComparison.Ordinal);
        var statusAt = markup.IndexOf("x:Name=\"StatusText\"", StringComparison.Ordinal);
        var statusTag = markup[markup.LastIndexOf('<', statusAt)..markup.IndexOf('>', statusAt)];
        Assert.Contains("Visibility=\"Collapsed\"", statusTag, StringComparison.Ordinal);

        // The version the footer prints is the bridge version, not a literal.
        var source = ReadSource(WindowSource);
        Assert.Contains("FooterVersionText.Text = $\" \\u00b7 Companion {CompanionWire.Version}\"", source, StringComparison.Ordinal);
    }

    // -- The 940px collapse ---------------------------------------------------

    [Theory]
    [InlineData(1586, true, true)]
    [InlineData(1040, true, true)]
    [InlineData(1039, false, true)]
    [InlineData(960, false, true)]
    [InlineData(959, false, false)]
    [InlineData(940, false, false)]
    public void Narrow_windows_shed_the_wordmark_first_then_the_divider(
        double chromeWidth, bool brandVisible, bool dividerVisible)
    {
        Assert.Equal(brandVisible, WebView2Window.IsBrandVisible(chromeWidth));
        Assert.Equal(dividerVisible, WebView2Window.IsDividerVisible(chromeWidth));
    }

    // -- Render proof ----------------------------------------------------------

    /// <summary>
    /// Renders the REAL chrome visuals (the shipped XAML with only event
    /// wiring stripped) at the mock width and pins every spec position within
    /// 6px. The PNGs land next to part 1's evidence. WPF layout runs on an
    /// explicit STA thread because the runner is MTA.
    /// </summary>
    [Fact]
    public void Native_chrome_renders_to_spec()
    {
        var evidenceDir = EvidenceDir();
        var proof = RunSta(() => RenderProof(ReadProofMarkup(), evidenceDir));
        _output.WriteLine(proof.Table);
        var failures = proof.Checks.Where(check => !check.Passed).ToList();
        Assert.True(
            failures.Count == 0,
            "chrome geometry off spec:\n" + string.Join("\n", failures.Select(failure => failure.Line)));
    }

    private sealed record Check(string Line, bool Passed);

    private sealed record Proof(IReadOnlyList<Check> Checks, string Table);

    private Proof RenderProof(string markup, string evidenceDir)
    {
        var lines = new List<string>();
        var checks = new List<Check>();
        void Check(string name, double expected, double actual, double tolerance = 6)
        {
            var ok = Math.Abs(expected - actual) <= tolerance;
            checks.Add(new Check($"{name}: expected {expected}, measured {actual:F1} {(ok ? "ok" : "OFF")}", ok));
            lines.Add($"{name,-28} expected {expected,7:F1}  measured {actual,7:F1}  {(ok ? "ok" : "OFF > 6px")}");
        }

        var window = (WpfWindow)WpfXamlReader.Parse(markup);

        // The tray gem cannot resolve from a test host (pack URI), so the
        // proof paints a code-generated 32x32 stand-in into the same fixed
        // box. Geometry is identical; the real asset wiring is pinned by
        // The_chrome_row_has_the_spec_elements_and_no_legacy_ones.
        ((WpfImage)window.FindName("BrandLogo")).Source = MakePlaceholderGem();

        // -- Title bar at 1586x54 ------------------------------------------
        var chrome = (WpfElement)window.FindName("ChromeRow");
        var chromeHost = new WpfGrid { Width = 1586, Height = 54 };
        ((WpfPanel)chrome.Parent!).Children.Remove(chrome);
        chromeHost.Children.Add(chrome);
        Layout(chromeHost, 1586, 54);

        // The pill the active tab wears, applied exactly the way SetTabVisual
        // does (same resource keys), so the Draft geometry includes it.
        var draftButton = (WpfButton)window.FindName("CompanionTabButton");
        draftButton.Background = (WpfBrush)window.FindResource("GoldPillBgBrush");
        draftButton.BorderBrush = (WpfBrush)window.FindResource("GoldPillBrush");
        draftButton.Foreground = (WpfBrush)window.FindResource("GoldPillBrush");
        draftButton.FontWeight = WpfFontWeights.SemiBold;
        draftButton.Tag = "Active";
        ((WpfTextBlock)window.FindName("CompanionDiamond")).Visibility = WpfVisibility.Visible;
        chromeHost.UpdateLayout();

        Save(chromeHost, 1586, 54, Path.Combine(evidenceDir, "native-titlebar.png"));

        WpfPoint At(WpfElement element, WpfElement relative) =>
            element.TranslatePoint(new WpfPoint(0, 0), relative);

        var logo = At((WpfElement)window.FindName("BrandLogo"), chrome);
        Check("logo x", 18, logo.X);
        Check("logo y", 11, logo.Y);
        var brand = At((WpfElement)window.FindName("BrandText"), chrome);
        Check("wordmark x", 66, brand.X);
        var divider = At((WpfElement)window.FindName("ChromeDivider"), chrome);
        Check("divider x", 213, divider.X);
        Check("back centre x", 245, CentreX((WpfElement)window.FindName("BackButton"), chrome));
        Check("forward centre x", 289, CentreX((WpfElement)window.FindName("ForwardButton"), chrome));
        Check("refresh centre x", 338, CentreX((WpfElement)window.FindName("RefreshButton"), chrome));
        var draft = At(draftButton, chrome);
        Check("draft pill x", 380, draft.X);
        Check("draft pill width", 108, draftButton.ActualWidth, tolerance: 10);
        Check("draft diamond x", 401, At((WpfElement)window.FindName("CompanionDiamond"), chrome).X);
        Check("u.gg x", 516, At((WpfElement)window.FindName("UggTabButton"), chrome).X);
        Check("coachless x", 595, At((WpfElement)window.FindName("CoachlessTabButton"), chrome).X);
        Check("mystats x", 715, At((WpfElement)window.FindName("OpGgTabButton"), chrome).X);
        Check("minimise centre x", 1424, CentreX((WpfElement)window.FindName("MinimizeButton"), chrome));
        Check("maximise centre x", 1485, CentreX((WpfElement)window.FindName("MaximizeButton"), chrome));
        Check("close centre x", 1547, CentreX((WpfElement)window.FindName("CloseButton"), chrome));

        // -- Footer at 1586x44 ---------------------------------------------
        var status = (WpfElement)window.FindName("StatusRow");
        var statusHost = new WpfGrid { Width = 1586, Height = 44 };
        ((WpfPanel)status.Parent!).Children.Remove(status);
        statusHost.Children.Add(status);
        Layout(statusHost, 1586, 44);
        Save(statusHost, 1586, 44, Path.Combine(evidenceDir, "native-footer.png"));

        Check("gear x", 30, At((WpfElement)window.FindName("FooterGear"), status).X);
        Check("footer text x", 80, At((WpfElement)window.FindName("FooterInfoText"), status).X);
        var profiles = (WpfElement)window.FindName("ProfilesButton");
        // The button carries 10px right padding, so the TEXT ends 10px inside.
        Check("profiles text ends x", 1557, At(profiles, status).X + profiles.ActualWidth - 10);

        var table = "native chrome geometry (window 1586):\n" + string.Join("\n", lines);
        return new Proof(checks, table);
    }

    private static double CentreX(WpfElement element, WpfElement relative) =>
        element.TranslatePoint(new WpfPoint(0, 0), relative).X + (element.ActualWidth / 2);

    /// <summary>A flat teal 32x32 stand-in for the tray gem (see above).</summary>
    private static System.Windows.Media.ImageSource MakePlaceholderGem()
    {
        const int size = 32;
        var pixels = new byte[size * size * 4];
        for (var i = 0; i < size * size; i++)
        {
            pixels[i * 4] = 0xA5;
            pixels[i * 4 + 1] = 0xC7;
            pixels[i * 4 + 2] = 0x1B;
            pixels[i * 4 + 3] = 0xFF;
        }

        var source = System.Windows.Media.Imaging.BitmapSource.Create(
            size, size, 96, 96, System.Windows.Media.PixelFormats.Bgra32, null, pixels, size * 4);
        source.Freeze();
        return source;
    }

    private static void Layout(WpfElement host, double width, double height)
    {
        host.Measure(new WpfSize(width, height));
        host.Arrange(new WpfRect(0, 0, width, height));
        host.UpdateLayout();
    }

    private static void Save(WpfElement host, int width, int height, string path)
    {
        var bitmap = new WpfRenderTargetBitmap(width, height, 96, 96, WpfPixelFormats.Pbgra32);
        bitmap.Render(host);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var stream = File.Open(path, FileMode.Create, FileAccess.Write, FileShare.None);
        encoder.Save(stream);
    }

    /// <summary>
    /// The shipped XAML minus what a loose <c>XamlReader</c> cannot honour:
    /// the code-behind class, the icon resources (test-host pack URIs) and
    /// the event wiring. Brushes, sizes, margins and templates are untouched,
    /// so the geometry measured is the geometry shipped.
    /// </summary>
    private static string ReadProofMarkup()
    {
        var markup = ReadSource(WindowMarkup);
        markup = markup.Replace(
            "x:Class=\"CoachBuild.Desktop.Web.WebView2Window\"",
            string.Empty,
            StringComparison.Ordinal);
        markup = Regex.Replace(markup, "\\s+Icon=\"pack://application:,,,/Assets/tray-icon\\.ico\"", string.Empty);
        markup = Regex.Replace(markup, "\\s+Source=\"pack://application:,,,/Assets/tray-icon\\.ico\"", string.Empty);
        markup = Regex.Replace(markup, "\\s+(Click|MouseRightButtonUp|SizeChanged)=\"[^\"]+\"", string.Empty);
        markup = Regex.Replace(
            markup,
            "<local:WebView2FallbackView\\b[^>]*?/>",
            "<Border x:Name=\"Fallback\" Visibility=\"Collapsed\" />",
            RegexOptions.Singleline);
        return markup;
    }

    private static T RunSta<T>(Func<T> work)
    {
        T? result = default;
        Exception? error = null;
        var thread = new Thread(() =>
        {
            try
            {
                result = work();
            }
            catch (Exception exception)
            {
                error = exception;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        if (!thread.Join(TimeSpan.FromMinutes(2)))
            throw new TimeoutException("the STA render proof did not finish in 2 minutes");
        if (error is not null)
            throw new InvalidOperationException("the STA render proof failed: " + error.Message, error);
        return result!;
    }

    private static string EvidenceDir()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(
                directory.FullName, "desktop", "src", "CoachBuild.Desktop",
                "Web", "WebView2Window.xaml");
            if (File.Exists(candidate))
                return Path.Combine(directory.FullName, "_evidence", "redesign-2.5.0");
            directory = directory.Parent;
        }

        throw new FileNotFoundException(
            $"Could not locate {WindowMarkup} above {AppContext.BaseDirectory}.");
    }

    private static string ReadSource(string relativePath)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(
                directory.FullName, "src", "CoachBuild.Desktop",
                relativePath.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(candidate)) return File.ReadAllText(candidate, Encoding.UTF8);
            directory = directory.Parent;
        }

        throw new FileNotFoundException(
            $"Could not locate {relativePath} above {AppContext.BaseDirectory}.");
    }
}
