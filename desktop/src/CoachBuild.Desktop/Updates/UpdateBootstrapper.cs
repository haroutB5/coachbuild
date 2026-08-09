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

    public static string ReleaseFeed => "https://github.com/haroutB5/coachbuild-desktop-releases";

    public static string InstallRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "CoachBuild", "Desktop");
}
