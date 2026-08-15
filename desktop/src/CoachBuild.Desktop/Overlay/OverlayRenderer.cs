using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using WpfBrushes = System.Windows.Media.Brushes;
using WpfColor = System.Windows.Media.Color;
using WpfHorizontalAlignment = System.Windows.HorizontalAlignment;

namespace CoachBuild.Desktop.Overlay;

public sealed record OverlayRenderModel(
    bool Visible,
    IReadOnlyList<Rect> AbilityRects,
    OverlayAbility? HighlightedAbility,
    CalibrationGeometry Calibration);

/// <summary>
/// Pure-ish projection plus a small WPF painter. The render signature is
/// immutable and includes every visual input; an unchanged signature returns
/// before touching the visual tree, which keeps idle redraws at zero.
/// </summary>
public sealed class OverlayRenderer
{
    private static readonly OverlayAbility[] AbilityValues = Enum.GetValues<OverlayAbility>();
    private OverlayRenderSignature? _lastSignature;

    public int RenderCount { get; private set; }

    public OverlayRenderSignature? LastSignature => _lastSignature;

    public OverlayRenderModel? LastModel { get; private set; }

    /// <summary>
    /// Drops the memoised signature so the next <see cref="Render"/> repaints
    /// unconditionally.
    ///
    /// Required because adjust mode paints the canvas directly (four alignment
    /// boxes plus a legend) WITHOUT going through Render, so the memoised
    /// signature still describes the pre-adjust picture. Leaving adjust mode
    /// with an unchanged state therefore hit `signature == _lastSignature`,
    /// returned early, and left the adjust boxes and legend stranded on screen
    /// over the game — the memo was reporting "nothing to repaint" about a
    /// canvas it had not painted.
    /// </summary>
    public void Invalidate() => _lastSignature = null;

    public bool ShouldRender(
        OverlayState state,
        DisplayResolution display,
        CalibrationGeometry? calibration = null)
    {
        return CreateSignature(state, display, calibration) != _lastSignature;
    }

    public bool Render(
        Canvas canvas,
        OverlayState state,
        OverlaySettings settings,
        DisplayResolution display,
        CalibrationGeometry? calibration = null)
    {
        ArgumentNullException.ThrowIfNull(canvas);
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(settings);

        var normalized = state.Normalize();
        var calibrations = settings.Calibrations ?? new Dictionary<string, PersistedCalibration>();
        var resolvedCalibration = calibration ?? (calibrations.TryGetValue(display.Key, out var saved)
            && saved.Resolution.Width == display.Width
            && saved.Resolution.Height == display.Height
            && saved.Resolution.DpiX == display.DpiX
            && saved.Resolution.DpiY == display.DpiY
            ? saved.Geometry.Normalize()
            : CalibrationGeometry.ScaledDefault(display));
        var signature = CreateSignatureNormalized(normalized, display, resolvedCalibration);
        if (signature == _lastSignature) return false;

        var model = BuildModelNormalized(normalized, resolvedCalibration);
        _lastSignature = signature;
        LastModel = model;
        RenderCount++;
        Paint(canvas, model);
        return true;
    }

    public OverlayRenderSignature CreateSignature(
        OverlayState state,
        DisplayResolution display,
        CalibrationGeometry? calibration = null)
    {
        var normalized = state.Normalize();
        var geometry = (calibration ?? CalibrationGeometry.ScaledDefault(display)).Normalize();
        return CreateSignatureNormalized(normalized, display, geometry);
    }

    private static OverlayRenderSignature CreateSignatureNormalized(
        OverlayState normalized,
        DisplayResolution display,
        CalibrationGeometry geometry)
    {
        var ranks = string.Join(',', AbilityValues.Select(normalized.Rank));
        var order = string.Join(',', normalized.SkillOrder.Order);
        return new OverlayRenderSignature(
            normalized.HasRenderableData,
            ranks,
            order,
            display.Key,
            geometry.FirstBoxCenterX,
            geometry.CenterY,
            geometry.BoxSize,
            geometry.Spacing);
    }

    public OverlayRenderModel BuildModel(
        OverlayState state,
        DisplayResolution display,
        CalibrationGeometry? calibration = null)
    {
        var normalized = state.Normalize();
        var geometry = (calibration ?? CalibrationGeometry.ScaledDefault(display)).Normalize();
        return BuildModelNormalized(normalized, geometry);
    }

    private static OverlayRenderModel BuildModelNormalized(
        OverlayState normalized,
        CalibrationGeometry geometry)
    {
        var spent = AbilityValues.Sum(normalized.Rank);
        var next = spent >= 0 && spent < normalized.SkillOrder.Order.Count
            ? normalized.SkillOrder.Order[spent]
            : (OverlayAbility?)null;
        if (next is not null && normalized.Rank(next.Value) >= 5) next = null;

        return new OverlayRenderModel(
            normalized.HasRenderableData,
            geometry.GetAbilityRects(),
            next,
            geometry);
    }

    private static void Paint(Canvas canvas, OverlayRenderModel model)
    {
        canvas.Children.Clear();
        if (!model.Visible) return;

        if (model.HighlightedAbility is { } next)
        {
            var rect = model.AbilityRects[(int)next];
            var highlight = new Border
            {
                Width = rect.Width,
                Height = rect.Height,
                BorderBrush = new SolidColorBrush(WpfColor.FromRgb(255, 47, 158)),
                BorderThickness = new Thickness(3),
                CornerRadius = new CornerRadius(8),
                Background = new SolidColorBrush(WpfColor.FromArgb(50, 255, 47, 158)),
                IsHitTestVisible = false,
                Child = new TextBlock
                {
                    Text = next.ToString(),
                    Foreground = WpfBrushes.White,
                    FontWeight = FontWeights.Bold,
                    FontSize = 12,
                    HorizontalAlignment = WpfHorizontalAlignment.Left,
                    VerticalAlignment = VerticalAlignment.Top,
                },
            };
            Canvas.SetLeft(highlight, rect.Left);
            Canvas.SetTop(highlight, rect.Top);
            canvas.Children.Add(highlight);
        }
    }
}

public sealed record OverlayRenderSignature(
    bool Visible,
    string Ranks,
    string Order,
    string DisplayKey,
    double FirstBoxCenterX,
    double CenterY,
    double BoxSize,
    double Spacing);
