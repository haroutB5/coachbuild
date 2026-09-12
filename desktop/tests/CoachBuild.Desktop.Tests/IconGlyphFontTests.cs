using System.Text;
using System.Xml.Linq;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// 2.5.1 regression. App.xaml declares an implicit TextBlock style with
/// FontFamily "Segoe UI". An implicit style beats an INHERITED FontFamily, so
/// an icon glyph that relied on its Button's font (Content="&amp;#xE72B;") was
/// drawn in Segoe UI — a missing-glyph box — in the live app, while every
/// render test (no App resources) looked right. Every icon-font glyph (Unicode
/// private-use area) must therefore sit in a TextBlock that sets FontFamily
/// itself.
/// </summary>
public sealed class IconGlyphFontTests
{
    [Fact]
    public void Every_icon_glyph_is_a_TextBlock_with_its_own_font()
    {
        var document = XDocument.Parse(ReadWindowMarkup());
        var offenders = new List<string>();
        foreach (var element in document.Descendants())
        {
            foreach (var attribute in element.Attributes())
            {
                if (!attribute.Value.Any(IsPrivateUse)) continue;
                var name = element.Attribute("{http://schemas.microsoft.com/winfx/2006/xaml}Name")?.Value ?? "(unnamed)";
                if (element.Name.LocalName != "TextBlock" || attribute.Name.LocalName != "Text")
                    offenders.Add($"{element.Name.LocalName} {name}: glyph in {attribute.Name.LocalName}, not TextBlock.Text");
                else if (element.Attribute("FontFamily") is null)
                    offenders.Add($"TextBlock {name}: no local FontFamily");
            }
        }

        Assert.True(offenders.Count == 0, string.Join(Environment.NewLine, offenders));
    }

    [Fact]
    public void The_app_still_declares_the_implicit_TextBlock_font_this_test_guards_against()
    {
        // If this ever goes away the rule above is merely belt-and-braces;
        // it is here so the reason for the rule stays visible.
        Assert.Contains("TargetType=\"TextBlock\"", ReadSource("App.xaml"), StringComparison.Ordinal);
    }

    private static bool IsPrivateUse(char c) => c >= '' && c <= '';

    private static string ReadWindowMarkup() => ReadSource(Path.Combine("Web", "WebView2Window.xaml"));

    private static string ReadSource(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, "desktop", "src", "CoachBuild.Desktop", relative);
            if (File.Exists(candidate)) return File.ReadAllText(candidate, Encoding.UTF8);
            directory = directory.Parent;
        }
        throw new FileNotFoundException($"could not locate desktop/src/CoachBuild.Desktop/{relative}");
    }
}
