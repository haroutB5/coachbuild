using System.Diagnostics;
using Microsoft.Win32;
using CoachBuild.Desktop.Overlay;

namespace CoachBuild.Desktop;

public interface IStartupManager
{
    bool IsEnabled { get; }

    void Enable();

    void Disable();
}

/// <summary>
/// Owns CoachBuild's per-user Windows startup entry. The registry path is
/// injectable so tests can use a temporary HKCU subkey without touching the
/// real Run key.
/// </summary>
public sealed class StartupManager : IStartupManager
{
    public const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public const string ValueName = "CoachBuild";
    public const string AutostartArgument = "--autostart";
    public const string StubFileName = "CoachBuild.Desktop.exe";

    private readonly string _runKeyPath;
    private readonly string _command;

    public StartupManager(string? executablePath = null, string? runKeyPath = null)
    {
        StubPath = ResolveStubPath(executablePath ?? GetCurrentExecutablePath());
        _command = BuildCommand(StubPath);
        _runKeyPath = string.IsNullOrWhiteSpace(runKeyPath) ? RunKeyPath : runKeyPath;
    }

    public string StubPath { get; }

    public string Command => _command;

    public bool IsEnabled
    {
        get
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(_runKeyPath, writable: false);
                var value = key?.GetValue(
                    ValueName,
                    defaultValue: null,
                    options: RegistryValueOptions.DoNotExpandEnvironmentNames);
                return value is string command
                    && string.Equals(command.Trim(), _command, StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                // Missing keys, malformed values, and unavailable registry
                // providers are all equivalent to disabled for the tray UI.
                return false;
            }
        }
    }

    public void Enable()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(_runKeyPath, writable: true);
            key?.SetValue(ValueName, _command, RegistryValueKind.String);
        }
        catch
        {
            // Startup should remain usable if a profile policy blocks writes.
            // The next explicit tray action can retry the operation.
        }
    }

    public void Disable()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(_runKeyPath, writable: true);
            key?.DeleteValue(ValueName, throwOnMissingValue: false);
        }
        catch
        {
            // Disabling startup is best effort; a locked or unavailable hive
            // must not prevent the tray app from shutting down or running.
        }
    }

    internal static string ResolveStubPath(string executablePath)
    {
        if (string.IsNullOrWhiteSpace(executablePath))
            throw new ArgumentException("An executable path is required.", nameof(executablePath));

        var fullPath = Path.GetFullPath(executablePath);
        var directory = Path.GetDirectoryName(fullPath);
        if (directory is not null
            && string.Equals(Path.GetFileName(directory), "current", StringComparison.OrdinalIgnoreCase))
        {
            var installRoot = Directory.GetParent(directory)?.FullName;
            if (!string.IsNullOrWhiteSpace(installRoot))
                return Path.Combine(installRoot, StubFileName);
        }

        return fullPath;
    }

    internal static string BuildCommand(string stubPath)
    {
        return $"\"{stubPath}\" {AutostartArgument}";
    }

    private static string GetCurrentExecutablePath()
    {
        if (!string.IsNullOrWhiteSpace(Environment.ProcessPath)) return Environment.ProcessPath;

        using var process = Process.GetCurrentProcess();
        return process.MainModule?.FileName
            ?? throw new InvalidOperationException("The current executable path could not be resolved.");
    }
}

public static class AutostartConfiguration
{
    public static bool EnsureConfigured(OverlaySettingsStore settings, IStartupManager startupManager)
    {
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(startupManager);

        if (settings.Read().AutostartConfigured) return false;

        startupManager.Enable();
        settings.SetAutostartConfigured(true);
        return true;
    }
}
