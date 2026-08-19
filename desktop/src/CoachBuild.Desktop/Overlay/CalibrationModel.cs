namespace CoachBuild.Desktop.Overlay;

public readonly record struct DisplayResolution(int Width, int Height, int DpiX = 96, int DpiY = 96, string DeviceName = "")
{
    public string Key => $"{Width}x{Height}@{DpiX}x{DpiY}:{DeviceName}";
}

/// <summary>
/// Four equally spaced boxes describe the ability HUD. Coordinates are in
/// physical pixels relative to the selected display's top-left corner.
/// </summary>
public sealed record CalibrationGeometry(
    double FirstBoxCenterX,
    double CenterY,
    double BoxSize,
    double Spacing)
{
    public const double MinBoxSize = 10;
    public const double MaxBoxSize = 200;
    public const double MinSpacing = 10;
    public const double MaxSpacing = 300;

    public static readonly CalibrationGeometry Reference = new(830, 1010, 48, 68);

    /// <summary>
    /// Where the <c>Situational</c> item row's badges START on a 1920x1080
    /// screen, before the player calibrates.
    ///
    /// <para><b>This is a starting position, not a measurement.</b> Unlike the
    /// ability HUD, the shop panel is draggable, resizable and scaled by the
    /// player's own <c>ShopScale</c> — and the two config files that hold
    /// <c>ShopScale</c> on the reference machine DISAGREE (<c>game.cfg</c>
    /// 0.4100, <c>PersistedSettings.json</c> 0.2000), so there is no value here
    /// worth deriving from config. Nothing is drawn until the player has saved
    /// a calibration for this target, precisely so a guessed default never
    /// paints numbers over the wrong part of their game.</para>
    /// </summary>
    public static readonly CalibrationGeometry ItemRowReference = new(430, 700, 44, 52);

    public CalibrationGeometry Normalize()
    {
        return this with
        {
            FirstBoxCenterX = Clamp(FiniteOr(FirstBoxCenterX, Reference.FirstBoxCenterX), -10000, 10000),
            CenterY = Clamp(FiniteOr(CenterY, Reference.CenterY), -10000, 10000),
            BoxSize = Clamp(FiniteOr(BoxSize, Reference.BoxSize), MinBoxSize, MaxBoxSize),
            Spacing = Clamp(FiniteOr(Spacing, Reference.Spacing), MinSpacing, MaxSpacing),
        };
    }

    public static CalibrationGeometry ScaledDefault(DisplayResolution display) =>
        ScaledFrom(Reference, display);

    /// <summary>The situational item row's starting geometry for this display.</summary>
    public static CalibrationGeometry ItemRowScaledDefault(DisplayResolution display) =>
        ScaledFrom(ItemRowReference, display);

    private static CalibrationGeometry ScaledFrom(CalibrationGeometry reference, DisplayResolution display)
    {
        var widthScale = display.Width / 1920d;
        var heightScale = display.Height / 1080d;
        return new CalibrationGeometry(
            Math.Round(reference.FirstBoxCenterX * widthScale),
            Math.Round(reference.CenterY * heightScale),
            Math.Round(reference.BoxSize * widthScale),
            Math.Round(reference.Spacing * widthScale)).Normalize();
    }

    public static CalibrationGeometry ForDpi(CalibrationGeometry geometry, int sourceDpi, int targetDpi)
    {
        if (sourceDpi <= 0 || targetDpi <= 0 || sourceDpi == targetDpi) return geometry.Normalize();
        var scale = targetDpi / (double)sourceDpi;
        return new CalibrationGeometry(
            geometry.FirstBoxCenterX * scale,
            geometry.CenterY * scale,
            geometry.BoxSize * scale,
            geometry.Spacing * scale).Normalize();
    }

    /// <summary>The four ability boxes. A fixed count, because a champion has four abilities.</summary>
    public IReadOnlyList<System.Windows.Rect> GetAbilityRects() => GetSlotRects(4);

    /// <summary>
    /// <paramref name="count"/> equally spaced boxes on the same pitch.
    ///
    /// <para>Split out of <see cref="GetAbilityRects"/> so the situational item
    /// row can share this arithmetic instead of carrying a second copy of it.
    /// The row's length is data (one badge per situational pick, 1 to 6 of
    /// them), where the ability bar's is not — but "first centre, then every
    /// <c>Spacing</c> after it" is the same statement in both cases, and two
    /// implementations of it would be two things to keep in step.</para>
    /// </summary>
    public IReadOnlyList<System.Windows.Rect> GetSlotRects(int count)
    {
        if (count <= 0) return Array.Empty<System.Windows.Rect>();
        var clean = Normalize();
        return Enumerable.Range(0, count)
            .Select(index => new System.Windows.Rect(
                clean.FirstBoxCenterX + index * clean.Spacing - clean.BoxSize / 2,
                clean.CenterY - clean.BoxSize / 2,
                clean.BoxSize,
                clean.BoxSize))
            .ToArray();
    }

    private static double FiniteOr(double value, double fallback) => double.IsFinite(value) ? value : fallback;

    private static double Clamp(double value, double min, double max) => Math.Min(max, Math.Max(min, value));
}

public sealed record CalibrationEntry(DisplayResolution Resolution, CalibrationGeometry Geometry)
{
    public CalibrationGeometry NormalizedGeometry => Geometry.Normalize();
}

public static class CalibrationModel
{
    public static CalibrationGeometry GetOrDefault(
        IReadOnlyDictionary<string, CalibrationEntry> entries,
        DisplayResolution display)
    {
        if (entries.TryGetValue(display.Key, out var entry)
            && entry.Resolution.Width == display.Width
            && entry.Resolution.Height == display.Height
            && entry.Resolution.DpiX == display.DpiX
            && entry.Resolution.DpiY == display.DpiY)
        {
            return entry.NormalizedGeometry;
        }

        return CalibrationGeometry.ScaledDefault(display);
    }

    public static IReadOnlyDictionary<string, CalibrationEntry> Put(
        IReadOnlyDictionary<string, CalibrationEntry> entries,
        DisplayResolution display,
        CalibrationGeometry geometry)
    {
        var next = new Dictionary<string, CalibrationEntry>(entries, StringComparer.OrdinalIgnoreCase)
        {
            [display.Key] = new CalibrationEntry(display, geometry.Normalize()),
        };
        return next;
    }
}

