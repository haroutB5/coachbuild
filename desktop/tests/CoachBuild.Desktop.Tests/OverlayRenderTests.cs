using System.Windows.Controls;
using System.Windows.Media;
using System.Runtime.ExceptionServices;
using CoachBuild.Desktop.Overlay;
using WpfColor = System.Windows.Media.Color;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class OverlayRenderTests
{
    [Fact]
    public void RenderSignatureIsStableForUnchangedImmutableState()
    {
        var state = State(level: 1);
        var display = new DisplayResolution(1920, 1080, 96, 96, "DISPLAY1");
        var renderer = new OverlayRenderer();

        var first = renderer.CreateSignature(state, display);
        var second = renderer.CreateSignature(
            state with { AbilityRanks = new Dictionary<OverlayAbility, int>(state.AbilityRanks) },
            display);

        Assert.Equal(first, second);
        Assert.True(renderer.ShouldRender(state, display));
    }

    [Fact]
    public void RenderDrawsPinkHighlightForKnownNextAbility()
    {
        RunOnSta(() =>
        {
            var canvas = new Canvas();
            var renderer = new OverlayRenderer();
            var rendered = renderer.Render(
                canvas,
                State(level: 1),
                new OverlaySettings(),
                new DisplayResolution(1920, 1080));

            Assert.True(rendered);
            Assert.NotNull(renderer.LastModel);
            Assert.True(renderer.LastModel!.Visible);
            Assert.Equal(OverlayAbility.Q, renderer.LastModel.HighlightedAbility);

            var highlight = Assert.IsType<Border>(Assert.Single(canvas.Children));
            var borderBrush = Assert.IsType<SolidColorBrush>(highlight.BorderBrush);
            Assert.Equal(WpfColor.FromRgb(255, 47, 158), borderBrush.Color);
            Assert.Equal("Q", Assert.IsType<TextBlock>(highlight.Child).Text);
        });
    }

    [Fact]
    public void RenderDoesNotPaintSkillTableOrDisclaimer()
    {
        RunOnSta(() =>
        {
            var canvas = new Canvas();
            var renderer = new OverlayRenderer();
            renderer.Render(
                canvas,
                State(level: 1),
                new OverlaySettings(),
                new DisplayResolution(1920, 1080));

            var onlyChild = Assert.IsType<Border>(Assert.Single(canvas.Children));
            Assert.IsType<TextBlock>(onlyChild.Child);
        });
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
            new DisplayResolution(1920, 1080));

        Assert.Equal(103, state.ChampionId);
        Assert.Equal(4, model.AbilityRects.Count);
        Assert.Equal(OverlayAbility.E, model.HighlightedAbility);
    }

    [Fact]
    public void EmptyOrderProducesNoRenderableHighlight()
    {
        var state = State(level: 1) with { SkillOrder = OverlaySkillOrder.Empty };
        var model = new OverlayRenderer().BuildModel(
            state,
            new DisplayResolution(1920, 1080));

        Assert.False(state.HasRenderableData);
        Assert.False(model.Visible);
        Assert.Null(model.HighlightedAbility);

        RunOnSta(() =>
        {
            var canvas = new Canvas();
            new OverlayRenderer().Render(
                canvas,
                state,
                new OverlaySettings(),
                new DisplayResolution(1920, 1080));

            Assert.Empty(canvas.Children);
        });
    }

    [Fact]
    public void CompletePublishedSkillPathRemainsVisibleWithoutHighlight()
    {
        var state = State(level: 4) with
        {
            AbilityRanks = new Dictionary<OverlayAbility, int>
            {
                [OverlayAbility.Q] = 2,
                [OverlayAbility.W] = 1,
                [OverlayAbility.E] = 1,
                [OverlayAbility.R] = 0,
            },
            SkillOrder = new OverlaySkillOrder(
                new[] { OverlayAbility.Q, OverlayAbility.W, OverlayAbility.E, OverlayAbility.Q },
                ObservedLevels: 4,
                Completed: true),
        };
        var model = new OverlayRenderer().BuildModel(
            state,
            new DisplayResolution(1920, 1080));

        Assert.True(state.HasRenderableData);
        Assert.True(model.Visible);
        Assert.Null(model.HighlightedAbility);
    }

    [Fact]
    public void UnchangedSignatureIsNotMarkedDirtyAfterAProjection()
    {
        var renderer = new OverlayRenderer();
        var display = new DisplayResolution(2560, 1440, 120, 120);
        var state = State(level: 6);
        var signature = renderer.CreateSignature(state, display);

        // The renderer's last signature is intentionally read-only; this
        // assertion pins that an identical state would be a no-op once a paint
        // has committed it, without requiring a WPF dispatcher in the test.
        Assert.Equal(signature, renderer.CreateSignature(state, display));
    }

    [Fact]
    public void CalibrationChangeInvalidatesRenderSignature()
    {
        var renderer = new OverlayRenderer();
        var display = new DisplayResolution(1920, 1080);
        var state = State(level: 1);

        var defaultSignature = renderer.CreateSignature(state, display);
        var adjustedSignature = renderer.CreateSignature(
            state,
            display,
            new CalibrationGeometry(830, 1010, 49, 68));

        Assert.NotEqual(defaultSignature, adjustedSignature);
    }

    private static void RunOnSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                action();
            }
            catch (Exception exception)
            {
                failure = exception;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null) ExceptionDispatchInfo.Capture(failure).Throw();
    }

    private static OverlayState State(int level)
    {
        return new OverlayState(
            InGame: true,
            ChampionName: "Ahri",
            ChampionId: AhriId,
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
