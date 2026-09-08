using CoachBuild.Core;
using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The champ-select offer the site tabs render, from the LCU snapshot to the
/// chip label.
///
/// <para>These sit on <see cref="CoreDesktopHostServices.ReadSnapshotAsync"/>
/// rather than on a helper, because the projection is only reachable in
/// production through that method and the tab chrome consumes exactly what it
/// returns. A test against a private helper would have passed with the
/// projection unwired, which is precisely the state this code was found in.</para>
/// </summary>
public sealed class ChampSelectOfferProjectionTests
{
    [Fact]
    public async Task No_champ_select_means_no_offer()
    {
        await using var host = NewHost(out _);
        host.State.SetPhase("None");

        var snapshot = await host.ReadSnapshotAsync(CancellationToken.None);

        Assert.Null(snapshot.ChampSelect);
    }

    [Fact]
    public async Task A_locked_champion_offers_its_build_page_for_the_assigned_role()
    {
        await using var host = NewHost(out _);
        EnterChampSelect(host, cellChampionId: 62, pickIntent: null, roleId: 1);

        var offer = (await host.ReadSnapshotAsync(CancellationToken.None)).ChampSelect;

        Assert.NotNull(offer);
        Assert.True(offer!.Locked);
        Assert.Equal("Wukong", offer.ChampionName);
        Assert.Equal("MonkeyKing", offer.ChampionKey);
        Assert.Equal(
            "https://u.gg/lol/champions/monkeyking/build/jungle",
            offer.UrlFor(CompanionTabs.UGg)!.ToString());
        Assert.Equal(
            "https://coachless.gg/builds/monkeyking?role=jungle",
            offer.UrlFor(CompanionTabs.Coachless)!.ToString());
        Assert.Equal("Open Wukong Jungle on u.gg", offer.ChipLabel(CompanionTabs.UGg));
    }

    /// <summary>
    /// A hover is the moment the offer is worth most, so it is carried — but it
    /// is carried AS a hover. Flattening the two would make the chip claim a
    /// pick that has not happened.
    /// </summary>
    [Fact]
    public async Task A_hovered_champion_is_offered_and_is_labelled_as_a_hover()
    {
        await using var host = NewHost(out _);
        EnterChampSelect(host, cellChampionId: null, pickIntent: 103, roleId: 2);

        var offer = (await host.ReadSnapshotAsync(CancellationToken.None)).ChampSelect;

        Assert.NotNull(offer);
        Assert.False(offer!.Locked);
        Assert.Equal("Ahri", offer.ChampionName);
        Assert.Contains("(hovered)", offer.ChipLabel(CompanionTabs.Coachless), StringComparison.Ordinal);
        Assert.Equal(
            "https://coachless.gg/builds/ahri?role=mid",
            offer.UrlFor(CompanionTabs.Coachless)!.ToString());
    }

    /// <summary>
    /// A locked pick wins over a stale hover on the same cell — the LCU leaves
    /// <c>championPickIntent</c> populated after the lock.
    /// </summary>
    [Fact]
    public async Task A_lock_beats_a_stale_hover_on_the_same_cell()
    {
        await using var host = NewHost(out _);
        EnterChampSelect(host, cellChampionId: 64, pickIntent: 103, roleId: 0);

        var offer = (await host.ReadSnapshotAsync(CancellationToken.None)).ChampSelect;

        Assert.Equal("Lee Sin", offer!.ChampionName);
        Assert.True(offer.Locked);
    }

    /// <summary>
    /// No roster, no offer. The slug and the label both come from the roster
    /// entry, so an offer built from a bare id would read "Open 62 on u.gg" or
    /// guess a URL. A missing offer is recoverable on the next tick; a wrong
    /// link is a page about the wrong champion.
    /// </summary>
    [Fact]
    public async Task An_unloaded_roster_withholds_the_offer_rather_than_guessing_a_slug()
    {
        await using var host = NewHost(out _, roster: new FakeChampionDirectory(preloaded: false));
        EnterChampSelect(host, cellChampionId: 62, pickIntent: null, roleId: 1);

        var offer = (await host.ReadSnapshotAsync(CancellationToken.None)).ChampSelect;

        Assert.Null(offer);
    }

    /// <summary>
    /// A champion with no assigned position still gets a link — just one
    /// without a role — rather than no link or an invented lane.
    /// </summary>
    [Fact]
    public async Task An_unknown_role_drops_the_role_from_the_link_instead_of_guessing_one()
    {
        await using var host = NewHost(out _);
        EnterChampSelect(host, cellChampionId: 103, pickIntent: null, roleId: null);

        var offer = (await host.ReadSnapshotAsync(CancellationToken.None)).ChampSelect;

        Assert.NotNull(offer);
        Assert.Equal(
            "https://u.gg/lol/champions/ahri/build",
            offer!.UrlFor(CompanionTabs.UGg)!.ToString());
        Assert.Equal("Open Ahri on u.gg", offer.ChipLabel(CompanionTabs.UGg));
    }

    /// <summary>
    /// A champion the roster does not carry (a brand-new release the cached
    /// roster predates) withholds the offer for the same reason an unloaded
    /// roster does.
    /// </summary>
    [Fact]
    public async Task A_champion_missing_from_the_roster_withholds_the_offer()
    {
        await using var host = NewHost(out _);
        EnterChampSelect(host, cellChampionId: 9001, pickIntent: null, roleId: 1);

        var offer = (await host.ReadSnapshotAsync(CancellationToken.None)).ChampSelect;

        Assert.Null(offer);
    }

    private static void EnterChampSelect(
        CoreDesktopHostServices host,
        int? cellChampionId,
        int? pickIntent,
        int? roleId)
    {
        host.State.SetPhase("ChampSelect");
        host.State.SetChampSelect(new CompanionChampSelectSnapshot(
            LocalPlayerCellId: 0,
            CellChampionId: cellChampionId,
            PickIntent: pickIntent,
            ActionChampionId: null,
            RoleId: roleId,
            TheirTeam: [],
            TimerPhase: "BAN_PICK"));
    }

    private static CoreDesktopHostServices NewHost(
        out string root,
        FakeChampionDirectory? roster = null)
    {
        root = Path.Combine(Path.GetTempPath(), "CoachBuild-OfferTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return new CoreDesktopHostServices(
            new string('a', 64),
            root,
            championDirectory: roster ?? new FakeChampionDirectory());
    }
}
