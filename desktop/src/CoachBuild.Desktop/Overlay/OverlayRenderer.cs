using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using WpfBrushes = System.Windows.Media.Brushes;
using WpfColor = System.Windows.Media.Color;
using WpfHorizontalAlignment = System.Windows.HorizontalAlignment;

namespace CoachBuild.Desktop.Overlay;

public sealed record OverlaySkillRow(
    int Level,
    OverlayAbility Ability,
    int RankAfter,
    bool Observed,
    bool IsNext);

public sealed record OverlayRenderModel(
    bool Visible,
    string Header,
    int Level,
    string LaneLabel,
    string Message,
    IReadOnlyList<OverlaySkillRow> Rows,
    IReadOnlyList<Rect> AbilityRects,
    OverlayAbility? HighlightedAbility,
    bool ShowDisclaimer,
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

    public bool ShouldRender(
        OverlayState state,
        OverlaySettings settings,
        DisplayResolution display,
        CalibrationGeometry? calibration = null,
        bool interactive = false)
    {
        return CreateSignature(state, settings, display, calibration, interactive) != _lastSignature;
    }

    public bool Render(
        Canvas canvas,
        OverlayState state,
        OverlaySettings settings,
        DisplayResolution display,
        bool interactive = false,
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
        var signature = CreateSignatureNormalized(normalized, settings, display, resolvedCalibration, interactive);
        if (signature == _lastSignature) return false;

        var model = BuildModelNormalized(normalized, settings, resolvedCalibration);
        _lastSignature = signature;
        LastModel = model;
        RenderCount++;
        Paint(canvas, model, settings, interactive);
        return true;
    }

    public OverlayRenderSignature CreateSignature(
        OverlayState state,
        OverlaySettings settings,
        DisplayResolution display,
        CalibrationGeometry? calibration = null,
        bool interactive = false)
    {
        var normalized = state.Normalize();
        var geometry = (calibration ?? CalibrationGeometry.ScaledDefault(display)).Normalize();
        return CreateSignatureNormalized(normalized, settings, display, geometry, interactive);
    }

    private static OverlayRenderSignature CreateSignatureNormalized(
        OverlayState normalized,
        OverlaySettings settings,
        DisplayResolution display,
        CalibrationGeometry geometry,
        bool interactive)
    {
        var ranks = string.Join(',', AbilityValues.Select(normalized.Rank));
        var order = string.Join(',', normalized.SkillOrder.Order);
        return new OverlayRenderSignature(
            normalized.InGame,
            normalized.ChampionName ?? string.Empty,
            normalized.ChampionId,
            normalized.Level,
            ranks,
            order,
            normalized.SkillOrder.ObservedLevels,
            normalized.SkillOrder.Completed,
            normalized.Lane ?? string.Empty,
            normalized.IsLaneAuto,
            normalized.ShowDisclaimer,
            settings.ShowSkillTable,
            interactive,
            display.Key,
            geometry.FirstBoxCenterX,
            geometry.CenterY,
            geometry.BoxSize,
            geometry.Spacing);
    }

    public OverlayRenderModel BuildModel(
        OverlayState state,
        OverlaySettings settings,
        DisplayResolution display,
        CalibrationGeometry? calibration = null)
    {
        var normalized = state.Normalize();
        var geometry = (calibration ?? CalibrationGeometry.ScaledDefault(display)).Normalize();
        return BuildModelNormalized(normalized, settings, geometry);
    }

    private static OverlayRenderModel BuildModelNormalized(
        OverlayState normalized,
        OverlaySettings settings,
        CalibrationGeometry geometry)
    {
        var spent = AbilityValues.Sum(normalized.Rank);
        var next = spent >= 0 && spent < normalized.SkillOrder.Order.Count
            ? normalized.SkillOrder.Order[spent]
            : (OverlayAbility?)null;
        if (next is not null && normalized.Rank(next.Value) >= 5) next = null;
        var nextIndex = next is null || spent >= normalized.SkillOrder.Order.Count ? -1 : spent;
        var rows = normalized.SkillOrder.Order
            .Take(18)
            .Select((ability, index) => new OverlaySkillRow(
                index + 1,
                ability,
                normalized.Rank(ability) + 1,
                index < normalized.SkillOrder.ObservedLevels,
                index == nextIndex && ability == next))
            .ToArray();

        // The next point is indexed by points already spent, not by a clock or
        // cooldown. Keep the lookup explicit so an unchanged state remains
        // unchanged even while a game is idle between level events.
        var message = !normalized.InGame
            ? string.Empty
            : normalized.SkillOrder.Order.Count == 0
                ? "No skill-order data for this champion and lane."
                : next is null
                    ? "No unspent skill point or the published path is complete."
                    : $"Next point: {next}";
        var laneLabel = normalized.Lane is null
            ? "Lane: Auto"
            : $"Lane: {normalized.Lane}{(normalized.IsLaneAuto ? " · auto" : " · manual")}";
        var header = string.IsNullOrWhiteSpace(normalized.ChampionName)
            ? "CoachBuild"
            : normalized.ChampionName!;

        return new OverlayRenderModel(
            normalized.HasRenderableData,
            header,
            normalized.Level,
            laneLabel,
            message,
            rows,
            geometry.GetAbilityRects(),
            next,
            normalized.ShowDisclaimer,
            geometry);
    }

    private static void Paint(Canvas canvas, OverlayRenderModel model, OverlaySettings settings, bool interactive)
    {
        canvas.Children.Clear();
        if (!model.Visible) return;

        if (settings.ShowSkillTable)
        {
            var panel = new Border
            {
                Width = 290,
                Padding = new Thickness(12),
                Background = new SolidColorBrush(WpfColor.FromArgb(224, 8, 13, 28)),
                BorderBrush = new SolidColorBrush(WpfColor.FromArgb(210, 82, 92, 130)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(8),
                IsHitTestVisible = interactive,
                Child = BuildTable(model),
            };
            Canvas.SetLeft(panel, 24);
            Canvas.SetTop(panel, 24);
            canvas.Children.Add(panel);
        }

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

        if (model.ShowDisclaimer)
        {
            var disclaimer = new TextBlock
            {
                Text = "CoachBuild recommendation · static skill data · no enemy or timer data",
                Foreground = new SolidColorBrush(WpfColor.FromArgb(205, 220, 220, 235)),
                FontSize = 10,
                IsHitTestVisible = false,
            };
            Canvas.SetLeft(disclaimer, 24);
            Canvas.SetTop(disclaimer, 180);
            canvas.Children.Add(disclaimer);
        }
    }

    private static StackPanel BuildTable(OverlayRenderModel model)
    {
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock
        {
            Text = $"{model.Header} · level {model.Level}",
            Foreground = WpfBrushes.White,
            FontWeight = FontWeights.SemiBold,
            FontSize = 16,
        });
        stack.Children.Add(new TextBlock
        {
            Text = model.LaneLabel,
            Foreground = new SolidColorBrush(WpfColor.FromRgb(255, 205, 90)),
            FontSize = 11,
            Margin = new Thickness(0, 2, 0, 8),
        });
        stack.Children.Add(new TextBlock
        {
            Text = model.Message,
            Foreground = new SolidColorBrush(WpfColor.FromRgb(220, 224, 236)),
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 8),
        });

        foreach (var row in model.Rows)
        {
            var item = new TextBlock
            {
                Text = $"{row.Level,2}   {row.Ability}   {row.RankAfter}",
                Foreground = row.IsNext ? new SolidColorBrush(WpfColor.FromRgb(255, 47, 158)) : WpfBrushes.White,
                FontWeight = row.IsNext ? FontWeights.Bold : FontWeights.Normal,
                FontSize = 12,
            };
            stack.Children.Add(item);
        }

        return stack;
    }
}

public sealed record OverlayRenderSignature(
    bool InGame,
    string ChampionName,
    int? ChampionId,
    int Level,
    string Ranks,
    string Order,
    int ObservedLevels,
    bool Completed,
    string Lane,
    bool LaneIsAuto,
    bool ShowDisclaimer,
    bool ShowSkillTable,
    bool Interactive,
    string DisplayKey,
    double FirstBoxCenterX,
    double CenterY,
    double BoxSize,
    double Spacing);
