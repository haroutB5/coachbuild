using System.Reflection;

namespace CoachBuild.Desktop.Updates;

/// <summary>
/// Thin entry-point adapter around Velopack's bootstrapper. Reflection keeps
/// the startup seam harmless for SelfTest and for an unpackaged developer run;
/// installed builds call VelopackApp.Build().Run() before WPF creates windows.
/// </summary>
public static class UpdateBootstrapper
{
    public static bool TryRun(string[] args)
    {
        if (args.Any(static arg => string.Equals(arg, "-SelfTest", StringComparison.OrdinalIgnoreCase))) return false;

        try
        {
            var type = Type.GetType("Velopack.VelopackApp, Velopack", throwOnError: false);
            var build = type?.GetMethod(
                "Build",
                BindingFlags.Public | BindingFlags.Static,
                binder: null,
                types: Type.EmptyTypes,
                modifiers: null);
            var builder = build?.Invoke(null, null);
            var run = builder?.GetType().GetMethod("Run", BindingFlags.Public | BindingFlags.Instance);
            run?.Invoke(builder, null);
            return run is not null;
        }
        catch
        {
            // A source checkout/unpacked executable has no Velopack bootstrapper
            // state. It should continue into WPF rather than fail to start.
            return false;
        }
    }

    public const string ReleaseFeed = "https://github.com/haroutB5/coachbuild-desktop-releases/releases/latest/download";

    /// <summary>
    /// Velopack's channel for a Windows pack, which is what publish.ps1 writes
    /// into sq.version and what names the metadata file on the feed. Pinned
    /// here so the release-asset names the app depends on are asserted in a
    /// test rather than assumed.
    /// </summary>
    public const string ReleaseChannel = "win";

    /// <summary>The exact metadata document a Velopack client requests.</summary>
    public static string ReleaseMetadataUrl => $"{ReleaseFeed}/releases.{ReleaseChannel}.json";

    /// <summary>The legacy metadata document older clients request.</summary>
    public static string LegacyReleaseMetadataUrl => $"{ReleaseFeed}/RELEASES";

    /// <summary>
    /// True when the feed is served as static release assets. GitHub's REST API
    /// rate-limits unauthenticated callers to 60 requests/hour/IP, which would
    /// make update checks fail intermittently and invisibly; the static
    /// /releases/latest/download endpoints have no such limit.
    /// </summary>
    public static bool UsesRateLimitedApi(string feed)
    {
        return feed.Contains("api.github.com", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Where Velopack actually installs a per-user package: %LOCALAPPDATA% plus
    /// the pack id, holding Update.exe, current\ and packages\. This used to
    /// read "CoachBuild\Desktop", which is a directory that does not exist and
    /// which the docs repeated; the app's *data* directory (companion.log,
    /// settings) is the separate %LOCALAPPDATA%\CoachBuild. Confirmed against a
    /// real install of the released 1.0.7 Setup.exe.
    /// </summary>
    public const string PackId = "CoachBuild.Desktop";

    public static string InstallRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        PackId);

    /// <summary>Where a downloaded-but-unapplied release sits.</summary>
    public static string StagedPackageDirectory => Path.Combine(InstallRoot, "packages");
}
