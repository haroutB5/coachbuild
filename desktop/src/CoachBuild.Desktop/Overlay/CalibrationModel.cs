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

    public static CalibrationGeometry ScaledDefault(DisplayResolution display)
    {
        var widthScale = display.Width / 1920d;
        var heightScale = display.Height / 1080d;
        return new CalibrationGeometry(
            Math.Round(Reference.FirstBoxCenterX * widthScale),
            Math.Round(Reference.CenterY * heightScale),
            Math.Round(Reference.BoxSize * widthScale),
            Math.Round(Reference.Spacing * widthScale)).Normalize();
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

    /// <summary>
    /// The four ability boxes: first centre, then every <c>Spacing</c> after it.
    ///
    /// <para>A FIXED count, because a champion has four abilities. 1.0.16 to
    /// 1.0.21 split this into a variable-length <c>GetSlotRects(count)</c> so
    /// the situational item row could share the pitch arithmetic; that row is
    /// gone and with it the only caller that ever passed anything but 4.</para>
    /// </summary>
    public IReadOnlyList<System.Windows.Rect> GetAbilityRects()
    {
        var clean = Normalize();
        return Enumerable.Range(0, 4)
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

