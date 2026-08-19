using System.Diagnostics;

namespace CoachBuild.Desktop.Diagnostics;

/// <summary>What the tray item will actually do, decided before anything runs.</summary>
public enum RevealKind
{
    /// <summary>The log exists: open its folder with the file highlighted.</summary>
    SelectFile,

    /// <summary>No log yet (fresh install): open the folder that will hold it.</summary>
    OpenFolder,

    /// <summary>The path could not be used at all. Nothing is launched; the reason is logged.</summary>
    Refused,
}

/// <summary>
/// One decision, separated from the process launch so it can be tested without
/// a window appearing on the bench.
/// </summary>
/// <param name="Kind">What will happen.</param>
/// <param name="Executable">Absolute path to explorer.exe, never a bare name.</param>
/// <param name="Arguments">The command line exactly as it will be passed.</param>
/// <param name="Directory">The folder that must exist before launching.</param>
/// <param name="LogLine">The companion.log line describing the outcome.</param>
public sealed record RevealPlan(
    RevealKind Kind,
    string Executable,
    string Arguments,
    string Directory,
    string LogLine);

/// <summary>
/// The tray's "Open log folder" action (1.0.14).
///
/// <para><b>Why it exists.</b> Every diagnosis in this project since 1.0.9 has
/// started with "open <c>%LOCALAPPDATA%\CoachBuild\companion.log</c>", which
/// the user has had to paste into an address bar by hand. The tray already
/// knows where the file is; it may as well take them there.</para>
///
/// <para><b>The path is never written down twice.</b> The caller passes the
/// <see cref="Core.RedactedLog.FilePath"/> of the log instance that is actually
/// writing, so a future change to the log location moves this item with it.
/// A hardcoded second copy of the path would keep opening the old folder and
/// look like it worked.</para>
///
/// <para><b>Quoting and injection.</b> The operand is always quoted. Measured
/// rather than assumed: on Windows 11, <c>explorer.exe /select,</c> also
/// accepts an <i>unquoted</i> path containing spaces — both forms opened the
/// right folder in a live probe — so the quoting is not what makes a spaced
/// path work. It is here so the command line does not depend on that leniency,
/// and so the operand's extent is unambiguous. What it does buy is the
/// refusal: a path that could not be quoted unambiguously — one containing a
/// quote, a newline or a NUL — is <see cref="RevealKind.Refused"/> rather than
/// passed to a shell and hoped about. <c>explorer.exe</c> is resolved to its absolute location under
/// <c>%WINDIR%</c> rather than off <c>PATH</c>, and launched with
/// <c>UseShellExecute = false</c>, so neither a <c>PATH</c> entry nor a shell
/// association can substitute a different binary.</para>
///
/// <para><b>Why the arguments are built as one string rather than an
/// ArgumentList.</b> Explorer's select syntax is <c>/select,"C:\path\file"</c>
/// — the switch and its operand are one token separated by a comma.
/// <c>ProcessStartInfo.ArgumentList</c> would quote each element separately and
/// produce something Explorer silently reinterprets as "open My Documents".
/// The refusal above is what makes hand-built quoting safe here.</para>
///
/// <para><b>Foreground and topmost.</b> Explorer is an ordinary top-level
/// window: it takes the foreground (the tray click already did) but it is not
/// topmost, so it cannot cover the overlay, which is. Adjust mode has no
/// deactivation handler — it ends only on Enter, Escape or an explicit tray
/// cancel — so an Explorer window appearing over the game does not end it.</para>
/// </summary>
public static class LogFolderReveal
{
    public const string LogPrefix = "tray: ";

    /// <summary>
    /// explorer.exe by absolute path. Resolving it from <c>PATH</c> would let
    /// any directory earlier on <c>PATH</c> decide what this menu item runs.
    /// </summary>
    public static string ExplorerPath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.Windows),
        "explorer.exe");

    /// <summary>
    /// Null when <paramref name="logFilePath"/> can be handed to Explorer, or
    /// the reason it cannot. Checked before any process is started.
    /// </summary>
    public static string? RejectionReason(string? logFilePath)
    {
        if (string.IsNullOrWhiteSpace(logFilePath)) return "no log path is configured";
        if (logFilePath.IndexOfAny(['"', '\r', '\n', '\0']) >= 0)
            return "the log path contains a character that cannot be quoted";

        // Checked on the ORIGINAL, before normalisation: Path.GetFullPath
        // happily resolves a relative path against the current directory, so
        // asking after the fact would call every relative path absolute and
        // open whatever folder the process happened to be started from.
        if (!Path.IsPathFullyQualified(logFilePath)) return "the log path is not absolute";

        string full;
        try
        {
            full = Path.GetFullPath(logFilePath);
        }
        catch (Exception error)
        {
            return $"the log path is not a usable path ({error.GetType().Name})";
        }

        if (string.IsNullOrEmpty(Path.GetDirectoryName(full))) return "the log path has no folder";
        return null;
    }

    /// <summary>
    /// Decides what to launch. Pure: the filesystem is supplied by the caller
    /// so both the fresh-install branch and the steady-state branch are
    /// reachable in a test without creating or deleting anything.
    /// </summary>
    public static RevealPlan Plan(
        string? logFilePath,
        Func<string, bool> fileExists,
        Func<string, bool> directoryExists)
    {
        ArgumentNullException.ThrowIfNull(fileExists);
        ArgumentNullException.ThrowIfNull(directoryExists);

        if (RejectionReason(logFilePath) is { } refusal)
        {
            return new RevealPlan(
                RevealKind.Refused,
                string.Empty,
                string.Empty,
                string.Empty,
                $"{LogPrefix}open log folder FAILED ({refusal})");
        }

        var full = Path.GetFullPath(logFilePath!);
        var directory = Path.GetDirectoryName(full)!;
        var fileName = Path.GetFileName(full);
        var explorer = ExplorerPath();

        if (fileExists(full))
        {
            // /select,"<file>" — the comma-joined form Explorer actually parses.
            return new RevealPlan(
                RevealKind.SelectFile,
                explorer,
                $"/select,\"{full}\"",
                directory,
                $"{LogPrefix}opened log folder ({fileName} selected)");
        }

        // A fresh install has the folder but no log until the first line is
        // written, and a very fresh one has neither. Opening the folder is
        // still the useful answer; silently doing nothing is not.
        var existed = directoryExists(directory);
        return new RevealPlan(
            RevealKind.OpenFolder,
            explorer,
            $"\"{directory}\"",
            directory,
            existed
                ? $"{LogPrefix}opened log folder (no {fileName} yet)"
                : $"{LogPrefix}opened log folder (created it; no {fileName} yet)");
    }
}

/// <summary>The process launch, behind a seam so a test never spawns a window.</summary>
public interface IShellLauncher
{
    void Start(string executable, string arguments);
}

/// <summary>The production launcher: explorer.exe, absolute, no shell.</summary>
public sealed class ExplorerLauncher : IShellLauncher
{
    public void Start(string executable, string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo
        {
            FileName = executable,
            Arguments = arguments,
            UseShellExecute = false,
        });
    }
}

/// <summary>
/// Plans, ensures the folder exists, launches, and returns the single line that
/// goes in companion.log. Never throws and never silently does nothing: every
/// path out of <see cref="Reveal"/> produces a line.
/// </summary>
public sealed class LogFolderRevealer(
    IShellLauncher? launcher = null,
    Func<string, bool>? fileExists = null,
    Func<string, bool>? directoryExists = null,
    Action<string>? createDirectory = null)
{
    private readonly IShellLauncher _launcher = launcher ?? new ExplorerLauncher();
    private readonly Func<string, bool> _fileExists = fileExists ?? File.Exists;
    private readonly Func<string, bool> _directoryExists = directoryExists ?? Directory.Exists;
    private readonly Action<string> _createDirectory =
        createDirectory ?? (path => Directory.CreateDirectory(path));

    public string Reveal(string? logFilePath)
    {
        var plan = LogFolderReveal.Plan(logFilePath, _fileExists, _directoryExists);
        if (plan.Kind == RevealKind.Refused) return plan.LogLine;

        try
        {
            if (!_directoryExists(plan.Directory)) _createDirectory(plan.Directory);
            _launcher.Start(plan.Executable, plan.Arguments);
            return plan.LogLine;
        }
        catch (Exception error)
        {
            return $"{LogFolderReveal.LogPrefix}open log folder FAILED "
                + $"({error.GetType().Name}: {error.Message})";
        }
    }
}
