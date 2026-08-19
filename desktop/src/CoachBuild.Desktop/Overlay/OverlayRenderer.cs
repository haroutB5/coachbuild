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
    CalibrationGeometry Calibration,
    IReadOnlyList<OverlayItemBadge>? Badges = null);

/// <summary>One WPA delta, and the item slot it belongs above.</summary>
/// <param name="Sign">-1, 0 or +1. Colour only — the NUMBER is <paramref name="Text"/>, verbatim.</param>
public readonly record struct OverlayItemBadge(Rect Slot, string Text, int Sign);

/// <summary>
/// Everything the situational badges need, or <see cref="None"/>.
///
/// <para><see cref="Geometry"/> is nullable and that is load-bearing: null
/// means the player has never calibrated the item row on this display, and the
/// only honest response to "we do not know where the shop row is" is to draw
/// nothing. There is no default position worth guessing — the shop panel is
/// draggable, resizable and scaled by a setting whose own two config files
/// disagree with each other.</para>
/// </summary>
public sealed record ItemBadgeInput(
    bool ShopOpen,
    IReadOnlyList<CoachBuild.Core.SituationalDelta> Deltas,
    CalibrationGeometry? Geometry)
{
    public static ItemBadgeInput None { get; } =
        new(false, Array.Empty<CoachBuild.Core.SituationalDelta>(), null);

    /// <summary>True only when there is a position, a number to draw, and a shop to draw it over.</summary>
    public bool WillDraw => ShopOpen && Geometry is not null && Deltas.Count > 0;

    /// <summary>
    /// Every visual input, flattened. Folded into the render signature so the
    /// memo cannot report "nothing to repaint" about a badge row that just
    /// appeared, changed number, or moved — the same trap 1.0.12 hit when the
    /// highlight gained a level gate and LEVEL was not yet in the signature.
    /// </summary>
    public string SignatureKey()
    {
        if (!WillDraw) return string.Empty;
        var geometry = Geometry!.Normalize();
        return string.Create(
            System.Globalization.CultureInfo.InvariantCulture,
            $"{geometry.FirstBoxCenterX}/{geometry.CenterY}/{geometry.BoxSize}/{geometry.Spacing}#")
            + string.Join(',', Deltas.Select(delta =>
                $"{delta.ItemId}:{delta.Text}:{Math.Sign(delta.Wpa)}"));
    }
}

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
        CalibrationGeometry? calibration = null,
        ItemBadgeInput? badges = null)
    {
        return CreateSignature(state, display, calibration, badges) != _lastSignature;
    }

    public bool Render(
        Canvas canvas,
        OverlayState state,
        OverlaySettings settings,
        DisplayResolution display,
        CalibrationGeometry? calibration = null,
        ItemBadgeInput? badges = null)
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
        var badgeInput = badges ?? ItemBadgeInput.None;
        var signature = CreateSignatureNormalized(normalized, display, resolvedCalibration, badgeInput);
        if (signature == _lastSignature) return false;

        var model = BuildModelNormalized(normalized, resolvedCalibration, badgeInput);
        _lastSignature = signature;
        LastModel = model;
        RenderCount++;
        Paint(canvas, model);
        return true;
    }

    public OverlayRenderSignature CreateSignature(
        OverlayState state,
        DisplayResolution display,
        CalibrationGeometry? calibration = null,
        ItemBadgeInput? badges = null)
    {
        var normalized = state.Normalize();
        var geometry = (calibration ?? CalibrationGeometry.ScaledDefault(display)).Normalize();
        return CreateSignatureNormalized(normalized, display, geometry, badges ?? ItemBadgeInput.None);
    }

    private static OverlayRenderSignature CreateSignatureNormalized(
        OverlayState normalized,
        DisplayResolution display,
        CalibrationGeometry geometry,
        ItemBadgeInput badges)
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
            geometry.Spacing,
            // 1.0.12: LEVEL is a visual input now. The highlight only draws
            // while a point is unspent, and the moment a level-up creates one
            // NOTHING ELSE in this signature moves — the ranks are unchanged,
            // that is the whole point. Without this the memo would report
            // "nothing to repaint" about the one frame the user is waiting for.
            normalized.Level,
            normalized.HasPointToSpend,
            // 1.0.16: the situational badges are a visual input with NOTHING
            // else in this signature behind them. Opening the shop changes no
            // rank, no level and no geometry, so without this the memo would
            // report "nothing to repaint" about the entire feature.
            badges.SignatureKey());
    }

    public OverlayRenderModel BuildModel(
        OverlayState state,
        DisplayResolution display,
        CalibrationGeometry? calibration = null,
        ItemBadgeInput? badges = null)
    {
        var normalized = state.Normalize();
        var geometry = (calibration ?? CalibrationGeometry.ScaledDefault(display)).Normalize();
        return BuildModelNormalized(normalized, geometry, badges ?? ItemBadgeInput.None);
    }

    private static OverlayRenderModel BuildModelNormalized(
        OverlayState normalized,
        CalibrationGeometry geometry,
        ItemBadgeInput badges)
    {
        // ONE implementation of "which ability", shared with
        // OverlayWindow.DescribeRenderOutcome. Through 1.0.11 this method kept
        // its own copy of the arithmetic, so the pixels and the log line were
        // two independent answers to the same question — and the unspent gate
        // would have had to be added to both.
        return new OverlayRenderModel(
            normalized.HasRenderableData,
            geometry.GetAbilityRects(),
            normalized.NextAbility(),
            geometry,
            BuildBadges(badges));
    }

    /// <summary>
    /// One badge per delta, positioned on the item row's own pitch.
    ///
    /// <para>The slot count is the number of DELTAS, not a constant: the
    /// situational row is between one and six items long depending on the
    /// champion, and drawing six badges over a four-item row would put two of
    /// them over whatever sits to the right of it.</para>
    /// </summary>
    private static IReadOnlyList<OverlayItemBadge> BuildBadges(ItemBadgeInput badges)
    {
        if (!badges.WillDraw) return Array.Empty<OverlayItemBadge>();
        var slots = badges.Geometry!.GetSlotRects(badges.Deltas.Count);
        var result = new List<OverlayItemBadge>(badges.Deltas.Count);
        for (var index = 0; index < badges.Deltas.Count && index < slots.Count; index++)
        {
            var delta = badges.Deltas[index];
            // An absent number draws nothing. It never draws "+0.00": a
            // placeholder is a claim about a measurement nobody made.
            if (string.IsNullOrWhiteSpace(delta.Text)) continue;
            result.Add(new OverlayItemBadge(slots[index], delta.Text, Math.Sign(delta.Wpa)));
        }

        return result;
    }

    // Near-opaque dark backing rather than a translucent tint or a text
    // outline: League's shop art is busy and light in places, and a number that
    // is only legible over some item icons is a number the player has to squint
    // at. The backing is one flat colour so the delta reads the same over every
    // icon in the row.
    private static readonly WpfColor BadgeBackground = WpfColor.FromArgb(238, 6, 10, 22);
    private static readonly WpfColor PositiveInk = WpfColor.FromRgb(74, 222, 128);
    private static readonly WpfColor NegativeInk = WpfColor.FromRgb(248, 113, 113);
    private static readonly WpfColor NeutralInk = WpfColor.FromRgb(226, 232, 240);

    /// <summary>
    /// Draws the WPA delta above each situational item.
    ///
    /// <para><b>Above the slot, never over it.</b> The badge's bottom edge sits
    /// just above the slot's top edge, so it covers neither the item icon nor
    /// the price the shop prints under it. Everything scales off the calibrated
    /// slot size, so a 4K player and a 1080p player get the same proportions
    /// rather than the same pixel count.</para>
    ///
    /// <para>Positive and negative are told apart by COLOUR AND by the sign
    /// character the web already put in the text (<c>+4.27</c> / <c>-0.06</c>),
    /// so the distinction survives a colour-blind player and a screenshot
    /// alike.</para>
    /// </summary>
    private static void PaintBadges(Canvas canvas, IReadOnlyList<OverlayItemBadge>? badges)
    {
        if (badges is null || badges.Count == 0) return;
        foreach (var badge in badges)
        {
            var slot = badge.Slot;
            if (slot.Width <= 0 || slot.Height <= 0) continue;

            var fontSize = Math.Clamp(slot.Height * 0.34, 9d, 22d);
            var ink = badge.Sign switch
            {
                > 0 => PositiveInk,
                < 0 => NegativeInk,
                _ => NeutralInk,
            };

            var pill = new Border
            {
                Background = new SolidColorBrush(BadgeBackground),
                BorderBrush = new SolidColorBrush(WpfColor.FromArgb(170, ink.R, ink.G, ink.B)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(fontSize * 0.38),
                Padding = new Thickness(fontSize * 0.42, fontSize * 0.10, fontSize * 0.42, fontSize * 0.14),
                IsHitTestVisible = false,
                SnapsToDevicePixels = true,
                Child = new TextBlock
                {
                    Text = badge.Text,
                    Foreground = new SolidColorBrush(ink),
                    FontWeight = FontWeights.Bold,
                    FontSize = fontSize,
                    TextAlignment = TextAlignment.Center,
                },
            };

            // Measured, then centred on the slot. A fixed width would either
            // clip "-0.06" or leave "+4.27" swimming, and the two occur in the
            // same row.
            pill.Measure(new System.Windows.Size(double.PositiveInfinity, double.PositiveInfinity));
            var size = pill.DesiredSize;
            var gap = Math.Max(2d, slot.Height * 0.08);
            Canvas.SetLeft(pill, slot.Left + (slot.Width - size.Width) / 2);
            Canvas.SetTop(pill, Math.Max(0d, slot.Top - size.Height - gap));
            canvas.Children.Add(pill);
        }
    }

    private static void Paint(Canvas canvas, OverlayRenderModel model)
    {
        canvas.Children.Clear();
        PaintBadges(canvas, model.Badges);
        // The badges are painted BEFORE this gate, not after it. `Visible` is
        // "there is a skill order to highlight", which has nothing to do with
        // whether the shop is open — a player with no skill-order data must
        // still get their item numbers.
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
    double Spacing,
    int Level = 0,
    bool HasPointToSpend = false,
    string Badges = "");
