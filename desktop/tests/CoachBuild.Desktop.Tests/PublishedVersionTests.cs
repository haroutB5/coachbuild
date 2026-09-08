using System.Reflection;
using CoachBuild.Core;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The number the Draft tab prints is the number of the app the user is
/// running.
///
/// <para>The Core-side test pins that <see cref="CompanionWire.Version"/> is
/// read off its own assembly rather than restated. That is necessary but not
/// sufficient: Core could carry a version of its own and still disagree with
/// the shipped app, which is precisely the pre-fix state (Core said 1.0.1,
/// Desktop said 2.1.0, and the published string said 2.0.0). Only the Desktop
/// test project can see both assemblies, so the cross-assembly assertion —
/// the one the user actually cares about — lives here.</para>
/// </summary>
public sealed class PublishedVersionTests
{
    [Fact]
    public void The_bridge_publishes_the_desktop_apps_own_version()
    {
        var desktop = Trimmed(typeof(WebView2Window).Assembly);
        var core = Trimmed(typeof(CompanionWire).Assembly);

        // Controls: both assemblies must actually declare something, or the
        // equality below could be "empty equals empty".
        Assert.False(string.IsNullOrWhiteSpace(desktop), "control: the desktop assembly must carry a version");
        Assert.False(string.IsNullOrWhiteSpace(core), "control: the core assembly must carry a version");
        Assert.NotEqual("0.0.0", desktop);

        Assert.Equal(desktop, core);
        Assert.Equal(desktop, CompanionWire.Version);
    }

    /// <summary>
    /// The Draft page reads this field and nothing else, so the field must stay
    /// on the status contract. (<c>desktop/ui/DraftPage.tsx</c> renders
    /// <c>Companion {status.version}</c>.)
    /// </summary>
    [Fact]
    public void The_status_contract_still_carries_the_version_the_draft_page_reads()
    {
        var status = new CompanionStatus(
            CompanionWire.Version, 48291, "None", false, null, null, null, null);
        Assert.Equal(CompanionWire.Version, status.Version);

        var json = System.Text.Json.JsonSerializer.Serialize(status, JsonOptions.Wire);
        Assert.Contains($"\"version\":\"{CompanionWire.Version}\"", json, StringComparison.Ordinal);
    }

    private static string Trimmed(Assembly assembly)
    {
        var informational = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion ?? string.Empty;
        var plus = informational.IndexOf('+');
        return (plus > 0 ? informational[..plus] : informational).Trim();
    }
}
