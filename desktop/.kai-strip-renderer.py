import io

p = 'src/CoachBuild.Desktop/Overlay/OverlayRenderer.cs'
s = io.open(p, encoding='utf-8').read()

s = s.replace("""public sealed record OverlayRenderModel(
    bool Visible,
    IReadOnlyList<Rect> AbilityRects,
    OverlayAbility? HighlightedAbility,
    CalibrationGeometry Calibration,
    IReadOnlyList<OverlayItemBadge>? Badges = null);
""", """public sealed record OverlayRenderModel(
    bool Visible,
    IReadOnlyList<Rect> AbilityRects,
    OverlayAbility? HighlightedAbility,
    CalibrationGeometry Calibration);
""")

start = s.index('/// <summary>One WPA delta, and the item slot it belongs above.</summary>')
end = s.index('/// <summary>\n/// Pure-ish projection plus a small WPF painter.')
s = s[:start] + s[end:]

start = s.index("""    /// <summary>
    /// The rects the badge pills were last actually painted at, in order.""")
end = s.index("""    /// <summary>
    /// Drops the memoised signature so the next <see cref="Render"/> repaints""")
s = s[:start] + s[end:]

s = s.replace("""    public bool ShouldRender(
        OverlayState state,
        DisplayResolution display,
        CalibrationGeometry? calibration = null,
        ItemBadgeInput? badges = null)
    {
        return CreateSignature(state, display, calibration, badges) != _lastSignature;
    }""", """    public bool ShouldRender(
        OverlayState state,
        DisplayResolution display,
        CalibrationGeometry? calibration = null)
    {
        return CreateSignature(state, display, calibration) != _lastSignature;
    }""")

s = s.replace("""        DisplayResolution display,
        CalibrationGeometry? calibration = null,
        ItemBadgeInput? badges = null)
    {
        ArgumentNullException.ThrowIfNull(canvas);""", """        DisplayResolution display,
        CalibrationGeometry? calibration = null)
    {
        ArgumentNullException.ThrowIfNull(canvas);""")

s = s.replace("""        var badgeInput = badges ?? ItemBadgeInput.None;
        var signature = CreateSignatureNormalized(normalized, display, resolvedCalibration, badgeInput);
        if (signature == _lastSignature) return false;

        var model = BuildModelNormalized(normalized, resolvedCalibration, badgeInput);
        _lastSignature = signature;
        LastModel = model;
        RenderCount++;
        LastBadgeRects = Paint(canvas, model);
        return true;""", """        var signature = CreateSignatureNormalized(normalized, display, resolvedCalibration);
        if (signature == _lastSignature) return false;

        var model = BuildModelNormalized(normalized, resolvedCalibration);
        _lastSignature = signature;
        LastModel = model;
        RenderCount++;
        Paint(canvas, model);
        return true;""")

s = s.replace("""    public OverlayRenderSignature CreateSignature(
        OverlayState state,
        DisplayResolution display,
        CalibrationGeometry? calibration = null,
        ItemBadgeInput? badges = null)
    {
        var normalized = state.Normalize();
        var geometry = (calibration ?? CalibrationGeometry.ScaledDefault(display)).Normalize();
        return CreateSignatureNormalized(normalized, display, geometry, badges ?? ItemBadgeInput.None);
    }""", """    public OverlayRenderSignature CreateSignature(
        OverlayState state,
        DisplayResolution display,
        CalibrationGeometry? calibration = null)
    {
        var normalized = state.Normalize();
        var geometry = (calibration ?? CalibrationGeometry.ScaledDefault(display)).Normalize();
        return CreateSignatureNormalized(normalized, display, geometry);
    }""")

s = s.replace("""        DisplayResolution display,
        CalibrationGeometry geometry,
        ItemBadgeInput badges)
    {
        var ranks""", """        DisplayResolution display,
        CalibrationGeometry geometry)
    {
        var ranks""")

s = s.replace("""            normalized.Level,
            normalized.HasPointToSpend,
            // 1.0.16: the situational badges are a visual input with NOTHING
            // else in this signature behind them. Opening the shop changes no
            // rank, no level and no geometry, so without this the memo would
            // report "nothing to repaint" about the entire feature.
            badges.SignatureKey());""", """            normalized.Level,
            normalized.HasPointToSpend);""")

s = s.replace("""    public OverlayRenderModel BuildModel(
        OverlayState state,
        DisplayResolution display,
        CalibrationGeometry? calibration = null,
        ItemBadgeInput? badges = null)
    {
        var normalized = state.Normalize();
        var geometry = (calibration ?? CalibrationGeometry.ScaledDefault(display)).Normalize();
        return BuildModelNormalized(normalized, geometry, badges ?? ItemBadgeInput.None);
    }""", """    public OverlayRenderModel BuildModel(
        OverlayState state,
        DisplayResolution display,
        CalibrationGeometry? calibration = null)
    {
        var normalized = state.Normalize();
        var geometry = (calibration ?? CalibrationGeometry.ScaledDefault(display)).Normalize();
        return BuildModelNormalized(normalized, geometry);
    }""")

s = s.replace("""    private static OverlayRenderModel BuildModelNormalized(
        OverlayState normalized,
        CalibrationGeometry geometry,
        ItemBadgeInput badges)
    {""", """    private static OverlayRenderModel BuildModelNormalized(
        OverlayState normalized,
        CalibrationGeometry geometry)
    {""")

s = s.replace("""            normalized.NextAbility(),
            geometry,
            BuildBadges(badges));
    }""", """            normalized.NextAbility(),
            geometry);
    }""")

start = s.index("""    /// <summary>
    /// One badge per delta, positioned on the item row's own pitch.""")
end = s.index("""    private static IReadOnlyList<Rect> Paint(Canvas canvas, OverlayRenderModel model)""")
s = s[:start] + s[end:]

s = s.replace("""    private static IReadOnlyList<Rect> Paint(Canvas canvas, OverlayRenderModel model)
    {
        canvas.Children.Clear();
        var badgeRects = PaintBadges(canvas, model.Badges);
        // The badges are painted BEFORE this gate, not after it. `Visible` is
        // "there is a skill order to highlight", which has nothing to do with
        // whether the shop is open — a player with no skill-order data must
        // still get their item numbers.
        if (!model.Visible) return badgeRects;

        if (model.HighlightedAbility is { } next)""", """    private static void Paint(Canvas canvas, OverlayRenderModel model)
    {
        canvas.Children.Clear();
        if (!model.Visible) return;

        if (model.HighlightedAbility is { } next)""")

s = s.replace("""            canvas.Children.Add(highlight);
        }

        return badgeRects;
    }
}""", """            canvas.Children.Add(highlight);
        }
    }
}""")

s = s.replace("""    int Level = 0,
    bool HasPointToSpend = false,
    string Badges = "");""", """    int Level = 0,
    bool HasPointToSpend = false);""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
