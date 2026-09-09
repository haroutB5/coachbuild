using System.Runtime.InteropServices;

namespace CoachBuild.Desktop;

/// <summary>
/// Puts the app and its WebView2 children under one Windows Job Object with
/// KILL_ON_JOB_CLOSE, so no renderer survives its parent (2.1.2).
///
/// <para>WHY. Fan-cleanup evidence 2026-09-09: 34 orphaned msedgewebview2
/// processes (~2.3GB) on the CoachBuild ugg profile survived force-kills of
/// the app during QA. Force-termination skips every managed disposal path
/// (DisposeBrowser, the worker release, the idle sweep), so the only thing
/// that can still reap the tree is the kernel: with KILL_ON_JOB_CLOSE the
/// last handle close — which a dead process performs unconditionally —
/// terminates every process still in the job.</para>
///
/// <para>INHERITANCE, and the honest residual gap. A child created by a
/// process in a job lands in the same job unless it is created with
/// CREATE_BREAKAWAY_FROM_JOB (and the job allows breakaway, which this one
/// does not request). WebView2 launches its browser/renderer tree through
/// its own Edge loader, which this app does not invoke and cannot flag —
/// so containment of any given msedgewebview2.exe is OBSERVED, not
/// assumed: the window logs one <c>webview2 job: N/M browser processes in
/// the app job</c> line per process lifetime (see the call in the window's
/// tab initialization). If that line ever reads less than N/N, the gap is
/// the loader escaping the job, and the deliberate decision is to document
/// it rather than hunt PIDs: killing processes by executable name risks
/// reaping the user's own Edge, which is worse than an orphan.</para>
///
/// <para>LIFETIME. The handle is intentionally NEVER closed. Closing the
/// last job handle IS the kill switch — a `using` or Dispose here would
/// terminate the app's own browser tree (and, nested, risk the app) the
/// moment it ran. The OS reclaims the handle at process death, which is
/// exactly when the kill switch must fire.</para>
/// </summary>
public static class ProcessJobObject
{
    /// <summary>JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. The one place it is spelled.</summary>
    public const uint KillOnJobCloseFlag = 0x2000;

    private const int JobObjectExtendedLimitInformation = 9;

    private const uint ProcessQueryInformation = 0x0400;
    private const uint ProcessQueryLimitedInformation = 0x1000;

    // The job handle. Zero until EnsureKillOnClose succeeds; never closed
    // afterwards (see the class note).
    private static nint _job;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public nuint MinimumWorkingSetSize;
        public nuint MaximumWorkingSetSize;
        public uint ActiveProcessCount;
        public nuint Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation Basic;
        public IoCounters Io;
        public nuint ProcessMemoryLimit;
        public nuint JobMemoryLimit;
        public nuint PeakProcessMemoryUsed;
        public nuint PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateJobObjectW(nint attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        nint job, int infoClass, ref ExtendedLimitInformation info, uint infoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(nint job, nint process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(nint process, nint job, [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        nint job, int infoClass, out ExtendedLimitInformation info, uint infoLength, out uint returnLength);

    [DllImport("kernel32.dll")]
    private static extern nint GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);

    /// <summary>
    /// Assigns the current process to the app job (creating it first),
    /// with KILL_ON_JOB_CLOSE set. Idempotent; never throws — containment
    /// is best effort and must not fail startup. True when this process is
    /// now kill-on-close contained.
    /// </summary>
    public static bool EnsureKillOnClose()
    {
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            var job = Volatile.Read(ref _job);
            if (job == nint.Zero)
            {
                job = CreateJobObjectW(nint.Zero, null);
                if (job == nint.Zero) return false;
                var info = new ExtendedLimitInformation();
                info.Basic.LimitFlags = KillOnJobCloseFlag;
                if (!SetInformationJobObject(
                        job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf<ExtendedLimitInformation>()))
                    return false;
                var previous = Interlocked.CompareExchange(ref _job, job, nint.Zero);
                if (previous != nint.Zero)
                {
                    // Lost the creation race: the winner's handle stands.
                    // (Deliberately not closed -- see the class note -- so
                    // the loser leaks one job handle with no processes in
                    // it, which is inert.)
                    job = previous;
                }
            }
            if (!AssignProcessToJobObject(job, GetCurrentProcess())) return false;
            return IsCurrentProcessKillOnClose();
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// True when the current process sits in the app job with
    /// KILL_ON_JOB_CLOSE set — the flag query the brief asks to be testable.
    /// Never throws.
    /// </summary>
    public static bool IsCurrentProcessKillOnClose()
    {
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            var job = Volatile.Read(ref _job);
            if (job == nint.Zero) return false;
            if (!IsProcessInJob(GetCurrentProcess(), job, out var inJob) || !inJob) return false;
            if (!QueryInformationJobObject(
                    job, JobObjectExtendedLimitInformation, out var info,
                    (uint)Marshal.SizeOf<ExtendedLimitInformation>(), out _))
                return false;
            return (info.Basic.LimitFlags & KillOnJobCloseFlag) != 0;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Whether a PID sits in the app job. Read-only diagnostics for the
    /// window's containment line; never throws, never acts.
    /// </summary>
    public static bool IsProcessInAppJob(int processId)
    {
        if (!OperatingSystem.IsWindows() || processId <= 0) return false;
        try
        {
            var job = Volatile.Read(ref _job);
            if (job == nint.Zero) return false;
            var handle = OpenProcess(ProcessQueryInformation, false, processId);
            if (handle == nint.Zero)
                handle = OpenProcess(ProcessQueryLimitedInformation, false, processId);
            if (handle == nint.Zero) return false;
            try
            {
                return IsProcessInJob(handle, job, out var inJob) && inJob;
            }
            finally
            {
                try
                {
                    CloseHandle(handle);
                }
                catch
                {
                }
            }
        }
        catch
        {
            return false;
        }
    }
}
