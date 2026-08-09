using CoachBuild.Desktop.Overlay;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class OverlayDpiTests
{
    [Fact]
    public void DefaultGeometryIsResolutionTaggedAndScaled()
    {
        var reference = CalibrationGeometry.ScaledDefault(new DisplayResolution(1920, 1080));
        var wide = CalibrationGeometry.ScaledDefault(new DisplayResolution(3840, 2160));

        Assert.Equal(830, reference.FirstBoxCenterX);
        Assert.Equal(1010, reference.CenterY);
        Assert.Equal(1660, wide.FirstBoxCenterX);
        Assert.Equal(2020, wide.CenterY);
    }

    [Fact]
    public void CalibrationIsNotReusedAcrossResolutionOrDpi()
    {
        var source = new DisplayResolution(1920, 1080, 96, 96, "DISPLAY1");
        var target = new DisplayResolution(1920, 1080, 144, 144, "DISPLAY1");
        var entries = CalibrationModel.Put(
            new Dictionary<string, CalibrationEntry>(),
            source,
            new CalibrationGeometry(900, 900, 50, 70));

        var targetGeometry = CalibrationModel.GetOrDefault(entries, target);

        Assert.NotEqual(900, targetGeometry.FirstBoxCenterX);
        Assert.Equal(CalibrationGeometry.ScaledDefault(target), targetGeometry);
    }

    [Fact]
    public void DpiScalingKeepsTheFourBoxesEvenlySpaced()
    {
        var geometry = CalibrationGeometry.ForDpi(new CalibrationGeometry(100, 900, 48, 68), 96, 144);
        var rects = geometry.GetAbilityRects();

        Assert.Equal(72, rects[0].Width);
        Assert.Equal(102, rects[1].Left - rects[0].Left);
        Assert.Equal(rects[0].Top, rects[3].Top);
    }
}

