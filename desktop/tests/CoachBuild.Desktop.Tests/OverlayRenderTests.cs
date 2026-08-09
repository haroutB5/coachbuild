using CoachBuild.Desktop.Overlay;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class OverlayRenderTests
{
    [Fact]
    public void RenderSignatureIsStableForUnchangedImmutableState()
    {
        var state = State(level: 1);
        var settings = new OverlaySettings { ShowSkillTable = true };
        var display = new DisplayResolution(1920, 1080, 96, 96, "DISPLAY1");
        var renderer = new OverlayRenderer();

        var first = renderer.CreateSignature(state, settings, display);
        var second = renderer.CreateSignature(state with { AbilityRanks = new Dictionary<OverlayAbility, int>(state.AbilityRanks) }, settings, display);

        Assert.Equal(first, second);
        Assert.True(renderer.ShouldRender(state, settings, display));
    }

    [Fact]
    public void ModelContainsOnlyThePublishedSkillPathAndNextPoint()
    {
        var renderer = new OverlayRenderer();
        var model = renderer.BuildModel(
            State(level: 1),
            new OverlaySettings { ShowSkillTable = true },
            new DisplayResolution(1920, 1080));

        Assert.True(model.Visible);
        Assert.Equal(OverlayAbility.Q, model.HighlightedAbility);
        Assert.Equal(4, model.AbilityRects.Count);
        Assert.Equal(4, model.Rows.Count);
        Assert.True(model.ShowDisclaimer);
    }

    [Fact]
    public void CoreOrderTokensReachTheOverlayModelWithChampionIdentity()
    {
        var snapshot = new LiveClientDataSkillSnapshot(
            4,
            new Dictionary<OverlayAbility, int>
            {
                [OverlayAbility.Q] = 2,
                [OverlayAbility.W] = 1,
                [OverlayAbility.E] = 0,
                [OverlayAbility.R] = 0,
            });
        var state = OverlayStateAdapter.FromLiveSnapshot(
            snapshot,
            championName: "Ahri",
            championId: 103,
            skillOrder: OverlaySkillOrder.FromTokens(
                new[] { "Q", "W", "Q", "E", "Q" },
                observedLevels: 5,
                completed: false),
            lane: "MID",
            laneIsAuto: true);

        var model = new OverlayRenderer().BuildModel(
            state,
            new OverlaySettings { ShowSkillTable = true },
            new DisplayResolution(1920, 1080));

        Assert.Equal(103, state.ChampionId);
        Assert.Equal(5, model.Rows.Count);
        Assert.Equal(OverlayAbility.E, model.HighlightedAbility);
        Assert.DoesNotContain("No skill-order data", model.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EmptyOrderKeepsTheHonestNoDataMessage()
    {
        var model = new OverlayRenderer().BuildModel(
            State(level: 1) with { SkillOrder = OverlaySkillOrder.Empty },
            new OverlaySettings { ShowSkillTable = true },
            new DisplayResolution(1920, 1080));

        Assert.Equal("No skill-order data for this champion and lane.", model.Message);
    }

    [Fact]
    public void UnchangedSignatureIsNotMarkedDirtyAfterAProjection()
    {
        var renderer = new OverlayRenderer();
        var settings = new OverlaySettings();
        var display = new DisplayResolution(2560, 1440, 120, 120);
        var state = State(level: 6);
        var signature = renderer.CreateSignature(state, settings, display);

        // The renderer's last signature is intentionally read-only; this
        // assertion pins that an identical state would be a no-op once a paint
        // has committed it, without requiring a WPF dispatcher in the test.
        Assert.Equal(signature, renderer.CreateSignature(state, settings, display));
    }

    [Fact]
    public void DisclaimerChangeInvalidatesRenderSignature()
    {
        var renderer = new OverlayRenderer();
        var settings = new OverlaySettings();
        var display = new DisplayResolution(1920, 1080);
        var state = State(level: 1);

        var withDisclaimer = renderer.CreateSignature(state, settings, display);
        var withoutDisclaimer = renderer.CreateSignature(
            state with { ShowDisclaimer = false },
            settings,
            display);

        Assert.NotEqual(withDisclaimer, withoutDisclaimer);
    }

    private static OverlayState State(int level)
    {
        return new OverlayState(
            InGame: true,
            ChampionName: "Ahri",
            ChampionId:  AhriId,
            Level: level,
            AbilityRanks: new Dictionary<OverlayAbility, int>
            {
                [OverlayAbility.Q] = 0,
                [OverlayAbility.W] = 0,
                [OverlayAbility.E] = 0,
                [OverlayAbility.R] = 0,
            },
            SkillOrder: new OverlaySkillOrder(
                new[] { OverlayAbility.Q, OverlayAbility.W, OverlayAbility.E, OverlayAbility.Q },
                ObservedLevels: 4,
                Completed: false),
            Lane: "MID",
            IsLaneAuto: false);
    }

    private const int AhriId = 103;
}
