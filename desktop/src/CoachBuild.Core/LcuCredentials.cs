using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace CoachBuild.Core;

public sealed record LeagueClientProcess(string Name, string? CommandLine);

public interface ILeagueClientProcessSource
{
    IEnumerable<LeagueClientProcess> GetProcesses();
}

/// <summary>
/// Process discovery is intentionally injectable. On Windows, a normal
/// Process object does not expose another process's command line without WMI
/// or native inspection; the optional provider lets the host use its
/// least-privilege process inspection while tests can supply exact fixtures.
/// </summary>
public sealed class WindowsLeagueClientProcessSource : ILeagueClientProcessSource
{
    public IEnumerable<LeagueClientProcess> GetProcesses()
    {
        foreach (var process in Process.GetProcessesByName("LeagueClientUx"))
        {
            string? commandLine = null;
            try
            {
                // StartInfo.Arguments is populated for processes started by the
                // current host and safely remains null/empty otherwise.
                commandLine = process.StartInfo?.Arguments;
            }
            catch
            {
                // Access can fail for a protected process; parsing must remain
                // null-safe and lockfile discovery already ran first.
            }
            if (string.IsNullOrWhiteSpace(commandLine))
                commandLine = NativeProcessCommandLine.TryRead(process.Id);
            yield return new LeagueClientProcess(process.ProcessName, commandLine);
            process.Dispose();
        }
    }

    private static class NativeProcessCommandLine
    {
        private const uint ProcessQueryLimitedInformation = 0x1000;
        private const uint ProcessVmRead = 0x0010;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("ntdll.dll")]
        private static extern int NtQueryInformationProcess(
            IntPtr processHandle,
            int processInformationClass,
            out ProcessBasicInformation processInformation,
            int processInformationLength,
            out int returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ReadProcessMemory(
            IntPtr process,
            IntPtr address,
            [Out] byte[] buffer,
            IntPtr size,
            out IntPtr bytesRead);

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessBasicInformation
        {
            public IntPtr Reserved1;
            public IntPtr PebBaseAddress;
            public IntPtr Reserved2_0;
            public IntPtr Reserved2_1;
            public IntPtr UniqueProcessId;
            public IntPtr Reserved3;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct UnicodeString
        {
            public ushort Length;
            public ushort MaximumLength;
            public IntPtr Buffer;
        }

        public static string? TryRead(int processId)
        {
            if (!OperatingSystem.IsWindows()) return null;
            var handle = OpenProcess(ProcessQueryLimitedInformation | ProcessVmRead, false, processId);
            if (handle == IntPtr.Zero) return null;
            try
            {
                if (NtQueryInformationProcess(handle, 0, out var basic, Marshal.SizeOf<ProcessBasicInformation>(), out _) != 0)
                    return null;
                var parametersAddress = ReadPointer(handle, IntPtr.Add(basic.PebBaseAddress, IntPtr.Size == 8 ? 0x20 : 0x10));
                if (parametersAddress == IntPtr.Zero) return null;
                var commandLineAddress = IntPtr.Add(parametersAddress, IntPtr.Size == 8 ? 0x70 : 0x40);
                var commandLine = ReadStruct<UnicodeString>(handle, commandLineAddress);
                if (commandLine.Length == 0 || commandLine.Buffer == IntPtr.Zero) return null;
                var bytes = new byte[commandLine.Length];
                return ReadProcessMemory(handle, commandLine.Buffer, bytes, bytes.Length, out var read) &&
                       read.ToInt64() == bytes.Length
                    ? System.Text.Encoding.Unicode.GetString(bytes)
                    : null;
            }
            catch
            {
                return null;
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        private static IntPtr ReadPointer(IntPtr process, IntPtr address)
        {
            var bytes = new byte[IntPtr.Size];
            return ReadProcessMemory(process, address, bytes, bytes.Length, out var read) && read.ToInt64() == bytes.Length
                ? IntPtr.Size == 8 ? new IntPtr(BitConverter.ToInt64(bytes, 0)) : new IntPtr(BitConverter.ToInt32(bytes, 0))
                : IntPtr.Zero;
        }

        private static T ReadStruct<T>(IntPtr process, IntPtr address) where T : struct
        {
            var size = Marshal.SizeOf<T>();
            var bytes = new byte[size];
            if (!ReadProcessMemory(process, address, bytes, size, out var read) || read.ToInt64() != size)
                return default;
            var handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try { return Marshal.PtrToStructure<T>(handle.AddrOfPinnedObject()); }
            finally { handle.Free(); }
        }
    }
}

public static partial class LcuCredentialParser
{
    public static LcuCredentials? ParseLockfile(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        try
        {
            var fields = raw.Trim().Split(':');
            if (fields.Length < 5 || !int.TryParse(fields[2], out var port) || port <= 0 || port > 65535)
                return null;
            var token = fields[3].Trim();
            return string.IsNullOrWhiteSpace(token)
                ? null
                : new LcuCredentials(port, token, "lockfile");
        }
        catch
        {
            return null;
        }
    }

    public static LcuCredentials? ParseProcessArguments(string? commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine)) return null;
        var portMatch = PortRegex().Match(commandLine);
        var tokenMatch = TokenRegex().Match(commandLine);
        if (!portMatch.Success || !tokenMatch.Success ||
            !int.TryParse(portMatch.Groups[1].Value, out var port) ||
            port <= 0 || port > 65535)
            return null;
        var token = (tokenMatch.Groups[1].Success
                ? tokenMatch.Groups[1].Value
                : tokenMatch.Groups[2].Value)
            .Trim()
            .Trim('"');
        return string.IsNullOrWhiteSpace(token)
            ? null
            : new LcuCredentials(port, token, "process-args");
    }

    [GeneratedRegex("(?:^|\\s)--app-port(?:=|\\s+)(\\d+)(?:\\s|$)", RegexOptions.IgnoreCase)]
    private static partial Regex PortRegex();

    [GeneratedRegex("(?:^|\\s)--remoting-auth-token(?:=|\\s+)(?:\"([^\"]+)\"|([^\\s]+))", RegexOptions.IgnoreCase)]
    private static partial Regex TokenRegex();

    public static string? ReadLockfile(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return null;
        try { return File.ReadAllText(path); }
        catch { return null; }
    }
}

public sealed class LcuCredentialResolver
{
    private readonly object _gate = new();
    private readonly ILeagueClientProcessSource _processSource;
    private readonly Func<string?, string?> _lockfileReader;
    private readonly string[] _lockfilePaths;
    private LcuCredentials? _cached;

    public LcuCredentialResolver(
        ILeagueClientProcessSource? processSource = null,
        Func<string?, string?>? lockfileReader = null,
        string? lockfilePath = null)
    {
        _processSource = processSource ?? new WindowsLeagueClientProcessSource();
        _lockfileReader = lockfileReader ?? LcuCredentialParser.ReadLockfile;
        var defaultPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            "Riot Games", "League of Legends", "lockfile");
        _lockfilePaths = string.IsNullOrWhiteSpace(lockfilePath)
            ? [
                // Riot's default installation path is the first candidate on
                // standard 64-bit Windows installations.
                @"C:\Riot Games\League of Legends\lockfile",
                defaultPath,
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    "Riot Games", "League of Legends", "lockfile")
            ]
            : [lockfilePath];
    }

    public LcuCredentials? Resolve()
    {
        lock (_gate)
        {
            if (_cached is not null) return _cached;

            // Deliberately lockfile first. It is the stable source and avoids a
            // process command-line read on every cold start.
            foreach (var path in _lockfilePaths.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var credentials = LcuCredentialParser.ParseLockfile(_lockfileReader(path));
                if (credentials is not null) return _cached = credentials;
            }

            try
            {
                foreach (var process in _processSource.GetProcesses())
                {
                    if (!string.Equals(process.Name, "LeagueClientUx", StringComparison.OrdinalIgnoreCase) &&
                        !string.Equals(process.Name, "LeagueClientUx.exe", StringComparison.OrdinalIgnoreCase))
                        continue;
                    var credentials = LcuCredentialParser.ParseProcessArguments(process.CommandLine);
                    if (credentials is not null) return _cached = credentials;
                }
            }
            catch
            {
                // Discovery is best effort; no client is the normal idle state.
            }
            return null;
        }
    }

    public LcuCredentials? GetCachedOrResolve() => Resolve();

    public void Invalidate()
    {
        lock (_gate) _cached = null;
    }

    public LcuCredentials? Cached
    {
        get { lock (_gate) return _cached; }
    }
}
