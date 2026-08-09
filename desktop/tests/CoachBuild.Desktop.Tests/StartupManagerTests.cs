using Microsoft.Win32;
using CoachBuild.Desktop.Overlay;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class StartupManagerTests
{
    [Fact]
    public void Enable_disable_round_trip_uses_an_isolated_run_key()
    {
        var root = $@"Software\CoachBuildTests\{Guid.NewGuid():N}";
        var runKeyPath = $@"{root}\Run";
        var currentExecutable = @"C:\Users\Test\AppData\Local\CoachBuild\Desktop\current\CoachBuild.Desktop.exe";

        try
        {
            var manager = new StartupManager(currentExecutable, runKeyPath);

            Assert.False(manager.IsEnabled);
            manager.Enable();

            Assert.True(manager.IsEnabled);
            using (var key = Registry.CurrentUser.OpenSubKey(runKeyPath))
            {
                Assert.Equal(
                    @"""C:\Users\Test\AppData\Local\CoachBuild\Desktop\CoachBuild.Desktop.exe"" --autostart",
                    key?.GetValue(StartupManager.ValueName));
            }

            manager.Disable();
            Assert.False(manager.IsEnabled);
        }
        finally
        {
            try { Registry.CurrentUser.DeleteSubKeyTree(root, throwOnMissingSubKey: false); } catch { }
        }
    }

    [Fact]
    public void IsEnabled_treats_missing_and_malformed_values_as_disabled()
    {
        var root = $@"Software\CoachBuildTests\{Guid.NewGuid():N}";
        var runKeyPath = $@"{root}\Run";
        try
        {
            var manager = new StartupManager(
                @"C:\dev\CoachBuild.Desktop.exe",
                runKeyPath);
            Assert.False(manager.IsEnabled);

            using (var key = Registry.CurrentUser.CreateSubKey(runKeyPath))
            {
                key!.SetValue(StartupManager.ValueName, new byte[] { 1, 2, 3 }, RegistryValueKind.Binary);
            }
            Assert.False(manager.IsEnabled);

            using (var key = Registry.CurrentUser.OpenSubKey(runKeyPath, writable: true))
            {
                key!.SetValue(StartupManager.ValueName, "not a CoachBuild command", RegistryValueKind.String);
            }
            Assert.False(manager.IsEnabled);
        }
        finally
        {
            try { Registry.CurrentUser.DeleteSubKeyTree(root, throwOnMissingSubKey: false); } catch { }
        }
    }

    [Fact]
    public void Velopack_current_path_resolves_to_the_install_root_stub()
    {
        var current = Path.Combine(
            Path.GetTempPath(),
            "CoachBuild",
            "Desktop",
            "current",
            StartupManager.StubFileName);
        var expected = Path.Combine(
            Path.GetTempPath(),
            "CoachBuild",
            "Desktop",
            StartupManager.StubFileName);

        var devPath = Path.GetFullPath(@"C:\dev\CoachBuild.Desktop.exe");
        Assert.Equal(expected, StartupManager.ResolveStubPath(current));
        Assert.Equal(devPath, StartupManager.ResolveStubPath(devPath));
    }

    [Fact]
    public void Fresh_settings_enable_startup_once_and_record_the_flag()
    {
        var root = MakeTempDirectory();
        try
        {
            var settings = new OverlaySettingsStore(Path.Combine(root, "desktop-settings.json"));
            var startup = new RecordingStartupManager();

            Assert.True(AutostartConfiguration.EnsureConfigured(settings, startup));
            Assert.Equal(1, startup.EnableCalls);
            Assert.True(settings.Read().AutostartConfigured);
            Assert.Contains("\"autostartConfigured\": true", File.ReadAllText(settings.Path));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Configured_settings_do_not_reenable_a_user_disabled_startup_entry()
    {
        var root = MakeTempDirectory();
        try
        {
            var settings = new OverlaySettingsStore(Path.Combine(root, "desktop-settings.json"));
            settings.SetAutostartConfigured(true);
            var startup = new RecordingStartupManager();

            Assert.False(AutostartConfiguration.EnsureConfigured(settings, startup));
            Assert.Equal(0, startup.EnableCalls);
            Assert.True(settings.Read().AutostartConfigured);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static string MakeTempDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "CoachBuild-AutostartTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private sealed class RecordingStartupManager : IStartupManager
    {
        public bool IsEnabled { get; private set; }

        public int EnableCalls { get; private set; }

        public void Enable()
        {
            EnableCalls++;
            IsEnabled = true;
        }

        public void Disable() => IsEnabled = false;
    }
}
