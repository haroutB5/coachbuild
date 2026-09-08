using System.Reflection;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The version the bridge publishes must BE the app's version, not a copy of
/// it that someone remembered to update.
///
/// <para>WHY THESE EXIST. Screenshots <c>_evidence/live-2.1.0/01,03,04</c>,
/// 2026-09-08: a 2.1.0 build printed "Companion 2.0.0" on the Draft tab,
/// because <c>CompanionWire.Version</c> was the literal <c>"2.0.0"</c> and had
/// simply not been edited across two releases. A test that pinned the literal
/// would have been perfectly green the whole time — it would have asserted the
/// bug. So what is pinned here is the RELATIONSHIP: the published string is
/// derived from the assembly, and the source carries no version literal for it
/// to drift from.</para>
/// </summary>
public sealed class CompanionVersionTests
{
    [Fact]
    public void The_published_version_is_read_off_the_assembly_not_restated()
    {
        var assembly = typeof(CompanionWire).Assembly;
        var informational = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion;
        Assert.False(
            string.IsNullOrWhiteSpace(informational),
            "control: the assembly must carry an informational version, or this test measures nothing");

        var plus = informational!.IndexOf('+');
        var expected = (plus > 0 ? informational[..plus] : informational).Trim();

        Assert.Equal(expected, CompanionWire.Version);
        // The floor the resolver falls back to must never be what ships.
        Assert.NotEqual("0.0.0", CompanionWire.Version);
    }

    [Fact]
    public void The_published_version_carries_no_build_metadata()
    {
        // "+<sha>" is a source revision, not something to print in a UI. The
        // Draft page renders this string verbatim.
        Assert.DoesNotContain('+', CompanionWire.Version);
        Assert.Equal(CompanionWire.Version.Trim(), CompanionWire.Version);
        Assert.NotEmpty(CompanionWire.Version);
    }

    /// <summary>
    /// The anti-drift assertion proper: there must be no version literal left
    /// in the wire contracts to disagree with the build. A future release bumps
    /// <c>desktop/src/Directory.Build.props</c> and nothing else.
    /// </summary>
    [Fact]
    public void The_wire_contract_source_holds_no_hardcoded_version()
    {
        var source = ReadSource("WireContracts.cs");
        // Control: the file this reads must be the right one, or an absent
        // literal below would be a vacuous pass on a bad path.
        Assert.Contains("class CompanionWire", source, StringComparison.Ordinal);
        Assert.Contains("ResolveVersion", source, StringComparison.Ordinal);

        Assert.DoesNotContain("Version = \"", source, StringComparison.Ordinal);
        Assert.DoesNotContain("\"2.0.0\"", source, StringComparison.Ordinal);
        Assert.DoesNotContain("\"2.1.0\"", source, StringComparison.Ordinal);
    }

    /// <summary>
    /// And the two shipped projects take their version from the one props file
    /// rather than restating it — which is the reason the Core assembly's
    /// version is the app's version at all.
    /// </summary>
    [Fact]
    public void Both_shipped_projects_inherit_the_single_version_property()
    {
        var props = ReadRepoFile("desktop", "src", "Directory.Build.props");
        Assert.Contains("<Version>", props, StringComparison.Ordinal);

        var core = ReadRepoFile("desktop", "src", "CoachBuild.Core", "CoachBuild.Core.csproj");
        var desktop = ReadRepoFile("desktop", "src", "CoachBuild.Desktop", "CoachBuild.Desktop.csproj");
        // Controls: the files exist and are the projects we mean.
        Assert.Contains("CoachBuild.Core", core, StringComparison.Ordinal);
        Assert.Contains("CoachBuild.Desktop", desktop, StringComparison.Ordinal);

        Assert.DoesNotContain("<Version>", core, StringComparison.Ordinal);
        Assert.DoesNotContain("<Version>", desktop, StringComparison.Ordinal);
    }

    private static string ReadSource(string relative) =>
        ReadRepoFile("desktop", "src", "CoachBuild.Core", relative);

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
