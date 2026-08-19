using CoachBuild.Desktop;
using CoachBuild.Desktop.Tray;
using CoachBuild.Desktop.Updates;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// 1.0.15 — surfacing, and then fixing, the hosted page running a web build
/// the site had already replaced.
/// </summary>
public sealed class WebFreshnessTests
{
    // ── When the check fires ──────────────────────────────────────────────────

    [Fact]
    public void The_check_fires_on_entering_champ_select_and_only_on_entering_it()
    {
        // Not "the phase is ChampSelect": that loop ticks every 350ms during a
        // draft (App.GameflowDelayForPhase), so a per-tick check would be
        // roughly 85 requests to the site per game.
        Assert.True(CoreDesktopHostServices.EnteredChampSelect("Lobby", "ChampSelect"));
        Assert.True(CoreDesktopHostServices.EnteredChampSelect("None", "ChampSelect"));
        Assert.True(CoreDesktopHostServices.EnteredChampSelect(null, "ChampSelect"));
        Assert.True(CoreDesktopHostServices.EnteredChampSelect("EndOfGame", "ChampSelect"));

        Assert.False(CoreDesktopHostServices.EnteredChampSelect("ChampSelect", "ChampSelect"));
        Assert.False(CoreDesktopHostServices.EnteredChampSelect("ChampSelect", "InProgress"));
        Assert.False(CoreDesktopHostServices.EnteredChampSelect("Lobby", "Lobby"));
        Assert.False(CoreDesktopHostServices.EnteredChampSelect("None", "InProgress"));
    }

    [Fact]
    public void The_phase_match_is_exact_so_an_unknown_phase_never_triggers_a_reload()
    {
        // Same discipline as CompanionPhase parsing: a future League phase
        // must not be silently treated as champ select.
        Assert.False(CoreDesktopHostServices.EnteredChampSelect("None", "champselect"));
        Assert.False(CoreDesktopHostServices.EnteredChampSelect("None", "ChampSelectV2"));
        Assert.False(CoreDesktopHostServices.EnteredChampSelect("None", null));
    }

    // ── What the tray says ────────────────────────────────────────────────────

    [Fact]
    public void The_tray_names_the_WEB_version_separately_from_the_app_version()
    {
        var state = Base() with { WebWindowOpen = true, WebVersion = "0.113.0" };
        Assert.Equal("Web: v0.113.0", state.WebVersionLine);
    }

    [Fact]
    public void No_window_and_an_untagged_page_read_differently()
    {
        // WebVersion == null alone cannot distinguish these, which is why the
        // open flag is its own field. "Web: unknown" over a closed window
        // would be a confident answer about nothing.
        var closed = Base() with { WebWindowOpen = false, WebVersion = null };
        var untagged = Base() with { WebWindowOpen = true, WebVersion = null };

        Assert.Equal("Web: no window open", closed.WebVersionLine);
        Assert.Equal("Web: unknown (page predates v0.113.0)", untagged.WebVersionLine);
        Assert.NotEqual(closed.WebVersionLine, untagged.WebVersionLine);
    }

    [Fact]
    public void A_default_tray_state_reports_no_window_rather_than_a_version()
    {
        Assert.Equal("Web: no window open", TrayMenuState.Default.WebVersionLine);
        Assert.Null(TrayMenuState.Default.WebVersion);
        Assert.False(TrayMenuState.Default.WebWindowOpen);
    }

    [Fact]
    public void The_web_version_is_carried_through_a_phase_update_untouched()
    {
        // WithPhase is called on every poll tick. If it dropped the field the
        // tray would flicker back to "no window open" once a second.
        var state = (Base() with { WebWindowOpen = true, WebVersion = "0.113.0" })
            .WithPhase("ChampSelect");
        Assert.Equal("Web: v0.113.0", state.WebVersionLine);
        Assert.Equal(CompanionPhase.ChampSelect, state.Phase);
    }

    private static TrayMenuState Base() => new(
        CompanionPhase.None,
        OverlayVisible: true,
        Interactive: false,
        LaneOverride: null,
        IsCompanionBusy: false,
        Error: null,
        UpdateTrayModel.None,
        LastOpen: null);
}
