using CoachBuild.Desktop.Tray;
using CoachBuild.Desktop.Updates;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The 2-hour loop is the fallback; these are the idle moments worth checking
/// at instead. Every trigger maps through <see cref="OpportunisticCheckPolicy"/>
/// so the cooldown and the phase table stay assertable without a clock.
/// </summary>
public sealed class OpportunisticCheckPolicyTests
{
    // ---------------------------------------------------------------- cooldown

    [Fact]
    public void The_cooldown_is_ten_minutes()
    {
        Assert.Equal(TimeSpan.FromMinutes(10), OpportunisticCheckPolicy.Cooldown);
    }

    [Theory]
    [InlineData(OpportunisticCheckTrigger.GameEnd)]
    [InlineData(OpportunisticCheckTrigger.WindowClosed)]
    [InlineData(OpportunisticCheckTrigger.SystemResume)]
    public void Every_trigger_checks_when_no_check_has_ever_run(OpportunisticCheckTrigger trigger)
    {
        var now = new DateTimeOffset(2026, 9, 8, 12, 0, 0, TimeSpan.Zero);

        Assert.True(OpportunisticCheckPolicy.ShouldCheck(trigger, now, lastCheckAt: null));
    }

    [Theory]
    [InlineData(OpportunisticCheckTrigger.GameEnd)]
    [InlineData(OpportunisticCheckTrigger.WindowClosed)]
    [InlineData(OpportunisticCheckTrigger.SystemResume)]
    public void Every_trigger_is_quiet_inside_the_cooldown(OpportunisticCheckTrigger trigger)
    {
        var now = new DateTimeOffset(2026, 9, 8, 12, 0, 0, TimeSpan.Zero);

        Assert.False(OpportunisticCheckPolicy.ShouldCheck(trigger, now, now - TimeSpan.FromMinutes(9)));
        Assert.False(OpportunisticCheckPolicy.ShouldCheck(trigger, now, now - TimeSpan.FromSeconds(30)));
    }

    [Theory]
    [InlineData(OpportunisticCheckTrigger.GameEnd)]
    [InlineData(OpportunisticCheckTrigger.WindowClosed)]
    [InlineData(OpportunisticCheckTrigger.SystemResume)]
    public void Every_trigger_checks_once_the_cooldown_elapses(OpportunisticCheckTrigger trigger)
    {
        var now = new DateTimeOffset(2026, 9, 8, 12, 0, 0, TimeSpan.Zero);

        Assert.True(OpportunisticCheckPolicy.ShouldCheck(trigger, now, now - TimeSpan.FromMinutes(10)));
        Assert.True(OpportunisticCheckPolicy.ShouldCheck(trigger, now, now - TimeSpan.FromHours(3)));
    }

    // ------------------------------------------------------- game-end mapping

    [Theory]
    [InlineData(CompanionPhase.InProgress, CompanionPhase.WaitingForStats)]
    [InlineData(CompanionPhase.InProgress, CompanionPhase.Lobby)]
    [InlineData(CompanionPhase.InProgress, CompanionPhase.EndOfGame)]
    [InlineData(CompanionPhase.InProgress, CompanionPhase.PreEndOfGame)]
    [InlineData(CompanionPhase.InProgress, CompanionPhase.None)]
    [InlineData(CompanionPhase.InProgress, CompanionPhase.Unknown)]
    [InlineData(CompanionPhase.Reconnect, CompanionPhase.Lobby)]
    [InlineData(CompanionPhase.Reconnect, CompanionPhase.WaitingForStats)]
    [InlineData(CompanionPhase.Reconnect, CompanionPhase.EndOfGame)]
    [InlineData(CompanionPhase.Reconnect, CompanionPhase.None)]
    public void Leaving_a_live_game_for_an_idle_phase_checks(CompanionPhase previous, CompanionPhase next)
    {
        Assert.True(OpportunisticCheckPolicy.IsGameEndTransition(previous, next));
    }

    [Theory]
    [InlineData(CompanionPhase.InProgress, CompanionPhase.InProgress)]
    [InlineData(CompanionPhase.InProgress, CompanionPhase.Reconnect)]
    [InlineData(CompanionPhase.InProgress, CompanionPhase.ChampSelect)]
    [InlineData(CompanionPhase.InProgress, CompanionPhase.Matchmaking)]
    [InlineData(CompanionPhase.InProgress, CompanionPhase.ReadyCheck)]
    [InlineData(CompanionPhase.Reconnect, CompanionPhase.InProgress)]
    [InlineData(CompanionPhase.Reconnect, CompanionPhase.ChampSelect)]
    [InlineData(CompanionPhase.Reconnect, CompanionPhase.Matchmaking)]
    [InlineData(CompanionPhase.ChampSelect, CompanionPhase.Lobby)]
    [InlineData(CompanionPhase.Matchmaking, CompanionPhase.Lobby)]
    [InlineData(CompanionPhase.ReadyCheck, CompanionPhase.None)]
    [InlineData(CompanionPhase.Lobby, CompanionPhase.None)]
    [InlineData(CompanionPhase.None, CompanionPhase.Lobby)]
    public void Busy_targets_and_non_game_sources_never_check(CompanionPhase previous, CompanionPhase next)
    {
        Assert.False(OpportunisticCheckPolicy.IsGameEndTransition(previous, next));
    }

    [Theory]
    [InlineData(CompanionPhase.Unknown, false)]
    [InlineData(CompanionPhase.None, false)]
    [InlineData(CompanionPhase.Lobby, false)]
    [InlineData(CompanionPhase.Matchmaking, true)]
    [InlineData(CompanionPhase.ReadyCheck, true)]
    [InlineData(CompanionPhase.Reconnect, true)]
    [InlineData(CompanionPhase.ChampSelect, true)]
    [InlineData(CompanionPhase.InProgress, true)]
    [InlineData(CompanionPhase.WaitingForStats, false)]
    [InlineData(CompanionPhase.EndOfGame, false)]
    [InlineData(CompanionPhase.PreEndOfGame, false)]
    public void The_busy_table_covers_exactly_the_restart_forbidden_phases(
        CompanionPhase phase,
        bool expectedBusy)
    {
        // Independent of the implementation: App owns Matchmaking/ReadyCheck/
        // Reconnect, ComplianceRules owns ChampSelect/InProgress. A phase added
        // to either table must fail here until this policy follows it.
        Assert.Equal(expectedBusy, OpportunisticCheckPolicy.IsUpdateBusyPhase(phase));
    }

    // ----------------------------------------------------- window-close mapping

    [Theory]
    [InlineData(true, false, true)]
    [InlineData(true, true, false)]
    [InlineData(false, false, false)]
    [InlineData(false, true, false)]
    public void Only_the_visible_to_hidden_flip_checks(bool wasVisible, bool isVisible, bool expected)
    {
        Assert.Equal(expected, OpportunisticCheckPolicy.IsWindowCloseTransition(wasVisible, isVisible));
    }

    // ------------------------------------------------ service cooldown wiring

    [Fact]
    public async Task The_service_stamps_each_check_and_opportunistic_triggers_obey_it()
    {
        var clock = new UpdateCheckClock();
        var client = new CountingUpdateClient();
        await using var service = new VelopackUpdateService(
            client,
            isCompanionBusy: () => false,
            checkInterval: TimeSpan.FromDays(1),
            timeProvider: clock);

        Assert.Null(service.LastCheckAt);

        await service.RequestOpportunisticCheckAsync(OpportunisticCheckTrigger.GameEnd);
        Assert.Equal(1, client.CheckCount);
        Assert.Equal(clock.GetUtcNow(), service.LastCheckAt);

        // A window close a minute later is inside the cooldown: no second hit.
        clock.Advance(TimeSpan.FromMinutes(1));
        await service.RequestOpportunisticCheckAsync(OpportunisticCheckTrigger.WindowClosed);
        await service.RequestOpportunisticCheckAsync(OpportunisticCheckTrigger.SystemResume);
        Assert.Equal(1, client.CheckCount);

        // Past the cooldown the next idle moment checks again.
        clock.Advance(TimeSpan.FromMinutes(10));
        await service.RequestOpportunisticCheckAsync(OpportunisticCheckTrigger.SystemResume);
        Assert.Equal(2, client.CheckCount);
    }

    [Fact]
    public async Task A_loop_check_arms_the_same_cooldown()
    {
        var clock = new UpdateCheckClock();
        var client = new CountingUpdateClient();
        await using var service = new VelopackUpdateService(
            client,
            isCompanionBusy: () => false,
            checkInterval: TimeSpan.FromDays(1),
            timeProvider: clock);

        await service.CheckNowAsync();
        Assert.Equal(1, client.CheckCount);

        await service.RequestOpportunisticCheckAsync(OpportunisticCheckTrigger.GameEnd);
        Assert.Equal(1, client.CheckCount);
    }

    private sealed class UpdateCheckClock : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 9, 8, 12, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan delta) => _now += delta;
    }

    private sealed class CountingUpdateClient : IUpdateClient
    {
        public int CheckCount { get; private set; }

        public string? CurrentVersion => "1.2.0";

        public Task<AvailableUpdate?> CheckForUpdatesAsync(CancellationToken cancellationToken)
        {
            CheckCount++;
            return Task.FromResult<AvailableUpdate?>(null);
        }

        public Task DownloadUpdatesAsync(AvailableUpdate update, CancellationToken cancellationToken) =>
            Task.CompletedTask;

        public Task ApplyUpdatesAndRestartAsync(AvailableUpdate update, CancellationToken cancellationToken) =>
            Task.CompletedTask;
    }
}
