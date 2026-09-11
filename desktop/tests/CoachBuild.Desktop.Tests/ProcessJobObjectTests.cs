using CoachBuild.Desktop;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The orphan containment (2.1.2): the app process must sit in a
/// KILL_ON_JOB_CLOSE job, so force-termination reaps the WebView2 tree with
/// it instead of orphaning msedgewebview2 processes. The flags are queried
/// back off the OS (P/Invoke on the own process), not read back from a
/// field the code set itself -- a test that only re-read its own write
/// could not fail.
/// </summary>
public sealed class ProcessJobObjectTests
{
    [Fact]
    public void Kill_on_close_assigns_the_current_process_and_is_idempotent()
    {
        if (!OperatingSystem.IsWindows()) return;

        Assert.True(ProcessJobObject.EnsureKillOnClose());
        Assert.True(ProcessJobObject.IsCurrentProcessKillOnClose());
        // Second call: the same job, no second assignment failure.
        Assert.True(ProcessJobObject.EnsureKillOnClose());
        Assert.True(ProcessJobObject.IsCurrentProcessKillOnClose());
    }

    /// <summary>
    /// The updater handoff (2.3.8): Update.exe inherits the job, so the flag
    /// must be off before the app exits or the kernel kills the updater
    /// mid-apply. Re-arming restores containment (and keeps this test from
    /// leaving the process uncontained for the others).
    /// </summary>
    [Fact]
    public void Releasing_kill_on_close_clears_the_flag_and_ensure_rearms_it()
    {
        if (!OperatingSystem.IsWindows()) return;

        Assert.True(ProcessJobObject.EnsureKillOnClose());
        Assert.True(ProcessJobObject.ReleaseKillOnClose());
        Assert.False(ProcessJobObject.IsCurrentProcessKillOnClose());
        Assert.True(ProcessJobObject.EnsureKillOnClose());
        Assert.True(ProcessJobObject.IsCurrentProcessKillOnClose());
    }

    [Fact]
    public void The_current_pid_is_in_the_app_job_and_garbage_is_not()
    {
        if (!OperatingSystem.IsWindows()) return;

        Assert.True(ProcessJobObject.EnsureKillOnClose());
        Assert.True(ProcessJobObject.IsProcessInAppJob(Environment.ProcessId));
        Assert.False(ProcessJobObject.IsProcessInAppJob(-1));
        Assert.False(ProcessJobObject.IsProcessInAppJob(0));
        // No such process: the query fails honestly instead of throwing.
        Assert.False(ProcessJobObject.IsProcessInAppJob(int.MaxValue));
    }
}
