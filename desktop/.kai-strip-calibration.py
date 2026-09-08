import io

# ── CalibrationModel.cs ──────────────────────────────────────────────────────
p = 'src/CoachBuild.Desktop/Overlay/CalibrationModel.cs'
s = io.open(p, encoding='utf-8').read()

start = s.index("""    /// <summary>
    /// Where the <c>Situational</c> item row's badges START on a 1920x1080""")
end = s.index("""    public CalibrationGeometry Normalize()""")
s = s[:start] + s[end:]

s = s.replace("""    public static CalibrationGeometry ScaledDefault(DisplayResolution display) =>
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
    }""", """    public static CalibrationGeometry ScaledDefault(DisplayResolution display)
    {
        var widthScale = display.Width / 1920d;
        var heightScale = display.Height / 1080d;
        return new CalibrationGeometry(
            Math.Round(Reference.FirstBoxCenterX * widthScale),
            Math.Round(Reference.CenterY * heightScale),
            Math.Round(Reference.BoxSize * widthScale),
            Math.Round(Reference.Spacing * widthScale)).Normalize();
    }""")

s = s.replace("""    /// <summary>The four ability boxes. A fixed count, because a champion has four abilities.</summary>
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
    }""", """    /// <summary>
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
    }""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)


# ── OverlaySettingsStore.cs ──────────────────────────────────────────────────
p = 'src/CoachBuild.Desktop/Overlay/OverlaySettingsStore.cs'
s = io.open(p, encoding='utf-8').read()

s = s.replace("""    /// <summary>
    /// Where the situational item row's numbers go — a SECOND calibration
    /// target, in its own map.
    ///
    /// <para><b>Why not an extension of <see cref="Calibrations"/>.</b> The two
    /// targets describe different things in different places on the screen: the
    /// ability HUD is fixed by League at the bottom centre and always has
    /// exactly four slots, while the shop panel is draggable, resizable, scaled
    /// by the player's own <c>ShopScale</c>, and shows between one and six
    /// situational items. One geometry cannot serve both, and folding them into
    /// one map keyed by display would mean a monitor change silently applied
    /// the ability bar's position to the shop row. A separate property also
    /// means an existing settings file simply lacks it, so nobody's ability-bar
    /// calibration is touched by this feature arriving.</para>
    ///
    /// <para><b>Empty means "do not draw".</b> There is no honest default for
    /// this position — see <c>CalibrationGeometry.ItemRowReference</c> — so an
    /// uncalibrated display draws no numbers at all rather than guessing a spot
    /// over the player's game.</para>
    /// </summary>
    [JsonPropertyName("itemRowCalibrations")]
    public Dictionary<string, PersistedCalibration> ItemRowCalibrations { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

/// <summary>Which of the two independently positioned overlays a calibration belongs to.</summary>
public enum CalibrationTarget
{
    /// <summary>The four ability boxes on League's HUD (1.0.7 onwards).</summary>
    SkillOrder,

    /// <summary>The situational item row inside the shop panel (1.0.16 onwards).</summary>
    ItemRow,
}""", """    /// <summary>
    /// The item row the WPA numbers used to be drawn on. NOTHING READS THIS.
    ///
    /// <para><b>It is kept solely so the player's saved geometry survives.</b>
    /// 1.0.22 removed the item-number overlay; this property is the only reason
    /// the <c>itemRowCalibrations</c> key in their <c>desktop-settings.json</c>
    /// is not silently deleted the next time any setting changes. <c>Save()</c>
    /// serialises this exact type, so a key this class does not model is
    /// DROPPED on the next write — the same trap
    /// <see cref="RankSampleSecret"/> documents, arriving from the other
    /// direction. Deleting the property would be a migration that throws away
    /// the player's work, and an unread JSON key costs nothing.</para>
    ///
    /// <para>There is deliberately no <c>CalibrationTarget</c> enum any more
    /// and no read path that can reach this map. If the numbers ever come back
    /// they will need a fresh position anyway: the reason they were removed is
    /// that a single saved origin cannot track a row whose Y depends on how
    /// many blocks the selected item set puts above it.</para>
    /// </summary>
    [JsonPropertyName("itemRowCalibrations")]
    public Dictionary<string, PersistedCalibration> ItemRowCalibrations { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}""")

s = s.replace("""    public void SaveCalibration(DisplayResolution display, CalibrationGeometry geometry) =>
        SaveCalibration(CalibrationTarget.SkillOrder, display, geometry);

    public void SaveCalibration(CalibrationTarget target, DisplayResolution display, CalibrationGeometry geometry)
    {
        lock (_gate)
        {
            var settings = ReadCore();
            Map(settings, target)[display.Key] = new PersistedCalibration
            {
                Resolution = display,
                Geometry = geometry.Normalize(),
            };
            WriteCore(settings);
        }
    }

    public CalibrationGeometry LoadCalibration(DisplayResolution display) =>
        TryLoadCalibration(CalibrationTarget.SkillOrder, display)
        ?? CalibrationGeometry.ScaledDefault(display);""", """    public void SaveCalibration(DisplayResolution display, CalibrationGeometry geometry)
    {
        lock (_gate)
        {
            var settings = ReadCore();
            settings.Calibrations[display.Key] = new PersistedCalibration
            {
                Resolution = display,
                Geometry = geometry.Normalize(),
            };
            WriteCore(settings);
        }
    }

    /// <summary>
    /// The skill-order geometry for this display: the saved one, else the
    /// scaled default.
    ///
    /// <para>Defaulting is correct HERE and was not for the item row: League
    /// fixes the ability HUD at the bottom centre, so
    /// <see cref="CalibrationGeometry.Reference"/> is a measurement rather than
    /// a guess. That asymmetry is why the two ever had separate load paths.</para>
    /// </summary>
    public CalibrationGeometry LoadCalibration(DisplayResolution display)
    {
        lock (_gate)
        {
            var settings = ReadCore();
            if (settings.Calibrations.TryGetValue(display.Key, out var calibration)
                && calibration.Resolution.Width == display.Width
                && calibration.Resolution.Height == display.Height
                && calibration.Resolution.DpiX == display.DpiX
                && calibration.Resolution.DpiY == display.DpiY)
            {
                return calibration.Geometry.Normalize();
            }

            return CalibrationGeometry.ScaledDefault(display);
        }
    }""")

start = s.index("""    /// <summary>
    /// The saved geometry for this target on this exact display, or null when""")
end = s.index("""    private OverlaySettings ReadCore()""")
s = s[:start] + s[end:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
