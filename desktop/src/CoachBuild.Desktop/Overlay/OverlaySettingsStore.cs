using System.Text.Json;
using System.Text.Json.Serialization;

namespace CoachBuild.Desktop.Overlay;

public sealed class OverlaySettings
{
    public string? LaneOverride { get; set; }

    public bool OverlayVisible { get; set; } = true;

    [JsonPropertyName("autostartConfigured")]
    public bool AutostartConfigured { get; set; }

    /// <summary>
    /// Whether a shop-key press may be IGNORED while League's chat input looks
    /// focused. <b>Off by default</b>, and there is no menu item for it.
    ///
    /// <para>The gate exists for a player whose shop bind is a letter that
    /// lands in typed words — League's default is <c>P</c> — and it is simply
    /// wrong for a player whose bind is not. The one it was built for read two
    /// games of <c>companion.log</c> and asked for their key to be honoured
    /// every single time, so the default flipped. It stays reachable by hand
    /// (<c>"chatGateEnabled": true</c> in this file) rather than being deleted,
    /// because the behaviour is still correct for the other player; it stays
    /// out of the tray because a visible control invites the flapping the
    /// evidence has already settled.</para>
    /// </summary>
    [JsonPropertyName("chatGateEnabled")]
    public bool ChatGateEnabled { get; set; }

    /// <summary>
    /// The shared account secret the ranked-LP capture posts with
    /// (<c>MYSTATS_ACCOUNT_SECRET</c> / <c>x-coachbuild-account-secret</c>).
    /// Empty or absent means capture is INERT — nothing is posted and one line
    /// says so in the log.
    ///
    /// <para><b>Why it lives here and not in a UI.</b> The secret has only ever
    /// existed in the BROWSER's localStorage
    /// (<c>components/live/mystatsAccount.ts</c>), because until now only the
    /// browser ever wrote to a gated endpoint. The desktop app posting samples
    /// at app start and at game end cannot depend on a page being open, so it
    /// needs its own copy — and how the user is supposed to GET one here is an
    /// open product question, not something this lane should answer by
    /// inventing a tray dialog for a secret. A hand-editable settings key is the
    /// smallest thing that works and the easiest to replace. See
    /// HANDOFF-lp-capture.md.</para>
    ///
    /// <para>It must be a real property rather than an unmodelled JSON key:
    /// <c>Save()</c> serialises this exact type, so a key this class does not
    /// know about is DELETED the next time the user toggles the overlay.</para>
    /// </summary>
    [JsonPropertyName("rankSampleSecret")]
    public string? RankSampleSecret { get; set; }

    public Dictionary<string, PersistedCalibration> Calibrations { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
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
}

public sealed class PersistedCalibration
{
    public DisplayResolution Resolution { get; set; }

    public CalibrationGeometry Geometry { get; set; } = CalibrationGeometry.Reference;
}

/// <summary>
/// Merge-safe settings persistence for lane, overlay visibility, and
/// resolution/DPI-tagged calibration. It also reads the Electron settings
/// shape once, so an upgrade does not silently discard a user's alignment.
/// </summary>
public sealed class OverlaySettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.General)
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter() },
    };

    private readonly object _gate = new();
    private readonly string _path;
    private OverlaySettings? _cachedSettings;

    public OverlaySettingsStore(string path)
    {
        _path = path ?? throw new ArgumentNullException(nameof(path));
    }

    public string Path => _path;

    public OverlaySettings Read()
    {
        lock (_gate)
        {
            return CloneSettings(ReadCore());
        }
    }

    public void Save(OverlaySettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        lock (_gate)
        {
            WriteCore(Normalize(CloneSettings(settings)));
        }
    }

    public void SetLaneOverride(string? lane)
    {
        lock (_gate)
        {
            var settings = ReadCore();
            settings.LaneOverride = NormalizeLane(lane);
            WriteCore(settings);
        }
    }

    public void SetOverlayVisible(bool visible)
    {
        lock (_gate)
        {
            var settings = ReadCore();
            settings.OverlayVisible = visible;
            WriteCore(settings);
        }
    }

    public void SetAutostartConfigured(bool configured)
    {
        lock (_gate)
        {
            var settings = ReadCore();
            settings.AutostartConfigured = configured;
            WriteCore(settings);
        }
    }

    public void SaveCalibration(DisplayResolution display, CalibrationGeometry geometry) =>
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
        ?? CalibrationGeometry.ScaledDefault(display);

    /// <summary>
    /// The saved geometry for this target on this exact display, or null when
    /// the player has never calibrated it here.
    ///
    /// <para>Returning null rather than a default is the whole point for the
    /// item row: "no calibration" and "the default calibration" are different
    /// facts, and the item row must draw nothing in the first case. The skill
    /// overlay keeps its defaulting behaviour through
    /// <see cref="LoadCalibration(DisplayResolution)"/>, because there the
    /// default IS a measurement — the ability HUD does not move.</para>
    /// </summary>
    public CalibrationGeometry? TryLoadCalibration(CalibrationTarget target, DisplayResolution display)
    {
        lock (_gate)
        {
            var settings = ReadCore();
            if (Map(settings, target).TryGetValue(display.Key, out var calibration)
                && calibration.Resolution.Width == display.Width
                && calibration.Resolution.Height == display.Height
                && calibration.Resolution.DpiX == display.DpiX
                && calibration.Resolution.DpiY == display.DpiY)
            {
                var geometry = calibration.Geometry.Normalize();

                // An item row stored at EXACTLY this display's untouched
                // default is not a calibration, it is the starting position
                // written out by a save that should never have happened, and
                // it must not be treated as a measurement.
                //
                // This exists because it already shipped. 1.0.18's field log
                // reads `badges: 6 shown at 544x904 size 59 pitch 69` on
                // 2560x1440 — ItemRowScaledDefault to the pixel — and the
                // player's report is that the pills sit well below their shop's
                // Situational row. The write path is fixed above, but the
                // player's settings.json already holds the bad entry and no
                // one is going to hand-edit JSON. Reading it as "never
                // positioned" is what makes the fix reach them: the badges stop
                // painting over their game and ReportBadgeReason names the tray
                // item that fixes it.
                //
                // The cost is that a player who genuinely lines the row up on
                // the default to within a rounding error loses it. Four
                // independent doubles agreeing exactly is not something a
                // human does with arrow keys.
                if (target == CalibrationTarget.ItemRow
                    && IsSameGeometry(geometry, CalibrationGeometry.ItemRowScaledDefault(display)))
                {
                    return null;
                }

                return geometry;
            }

            return null;
        }
    }

    private static bool IsSameGeometry(CalibrationGeometry left, CalibrationGeometry right) =>
        Math.Abs(left.FirstBoxCenterX - right.FirstBoxCenterX) < 0.001
        && Math.Abs(left.CenterY - right.CenterY) < 0.001
        && Math.Abs(left.BoxSize - right.BoxSize) < 0.001
        && Math.Abs(left.Spacing - right.Spacing) < 0.001;

    /// <summary>The geometry to START an adjustment from: the saved one, else this target's default.</summary>
    public CalibrationGeometry LoadCalibrationOrDefault(CalibrationTarget target, DisplayResolution display) =>
        TryLoadCalibration(target, display)
        ?? (target == CalibrationTarget.ItemRow
            ? CalibrationGeometry.ItemRowScaledDefault(display)
            : CalibrationGeometry.ScaledDefault(display));

    private static Dictionary<string, PersistedCalibration> Map(OverlaySettings settings, CalibrationTarget target) =>
        target == CalibrationTarget.ItemRow ? settings.ItemRowCalibrations : settings.Calibrations;

    private OverlaySettings ReadCore()
    {
        if (_cachedSettings is not null) return _cachedSettings;

        var settings = TryRead(_path);
        if (settings is not null) return _cachedSettings = Normalize(settings);

        // Electron's old path/shape. This is read-only migration input; the
        // first native write moves it into the new file.
        var legacyPath = System.IO.Path.Combine(
            System.IO.Path.GetDirectoryName(_path) ?? string.Empty,
            "coachbuild-overlay-settings.json");
        if (!string.Equals(legacyPath, _path, StringComparison.OrdinalIgnoreCase))
        {
            var legacy = TryReadLegacy(legacyPath);
            if (legacy is not null) return _cachedSettings = Normalize(legacy);
        }

        return _cachedSettings = new OverlaySettings();
    }

    private void WriteCore(OverlaySettings settings)
    {
        var directory = System.IO.Path.GetDirectoryName(_path);
        if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);

        var temporary = _path + ".tmp-" + Guid.NewGuid().ToString("N");
        File.WriteAllText(temporary, JsonSerializer.Serialize(settings, JsonOptions));
        File.Move(temporary, _path, overwrite: true);

        // Writes are the only mutation path. Refresh the in-memory snapshot so
        // the dispatcher never needs to reread JSON after a setting changes.
        _cachedSettings = Normalize(settings);
    }

    private static OverlaySettings CloneSettings(OverlaySettings settings)
    {
        return new OverlaySettings
        {
            LaneOverride = settings.LaneOverride,
            OverlayVisible = settings.OverlayVisible,
            AutostartConfigured = settings.AutostartConfigured,
            // Every field has to be here: Save() clones before it writes, so a
            // field missed in this method is silently reset to its default on
            // the next write of ANY other setting.
            ChatGateEnabled = settings.ChatGateEnabled,
            RankSampleSecret = settings.RankSampleSecret,
            Calibrations = CloneMap(settings.Calibrations),
            ItemRowCalibrations = CloneMap(settings.ItemRowCalibrations),
        };
    }

    private static Dictionary<string, PersistedCalibration> CloneMap(
        Dictionary<string, PersistedCalibration>? map)
    {
        return (map ?? new Dictionary<string, PersistedCalibration>())
            .Where(pair => pair.Value is not null)
            .ToDictionary(
                pair => pair.Key,
                pair => new PersistedCalibration
                {
                    Resolution = pair.Value.Resolution,
                    Geometry = pair.Value.Geometry.Normalize(),
                },
                StringComparer.OrdinalIgnoreCase);
    }

    private static OverlaySettings? TryRead(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            return JsonSerializer.Deserialize<OverlaySettings>(File.ReadAllText(path), JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    private static OverlaySettings? TryReadLegacy(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var root = document.RootElement;
            var settings = new OverlaySettings
            {
                LaneOverride = root.TryGetProperty("lane", out var lane) ? lane.GetString() : null,
            };

            if (root.TryGetProperty("calibration", out var calibration)
                && calibration.TryGetProperty("geometry", out var geometry)
                && calibration.TryGetProperty("calibratedWidth", out var width)
                && calibration.TryGetProperty("calibratedHeight", out var height)
                && width.TryGetInt32(out var w)
                && height.TryGetInt32(out var h))
            {
                var entry = new PersistedCalibration
                {
                    Resolution = new DisplayResolution(w, h),
                    Geometry = JsonSerializer.Deserialize<CalibrationGeometry>(geometry.GetRawText(), JsonOptions)
                        ?? CalibrationGeometry.Reference,
                };
                settings.Calibrations[entry.Resolution.Key] = entry;
            }

            return settings;
        }
        catch
        {
            return null;
        }
    }

    private static OverlaySettings Normalize(OverlaySettings settings)
    {
        settings.LaneOverride = NormalizeLane(settings.LaneOverride);
        settings.Calibrations = CloneMap(settings.Calibrations);
        settings.ItemRowCalibrations = CloneMap(settings.ItemRowCalibrations);
        return settings;
    }

    private static string? NormalizeLane(string? lane)
    {
        if (string.IsNullOrWhiteSpace(lane)) return null;
        var value = lane.Trim().ToUpperInvariant();
        return value is "TOP" or "JUNGLE" or "MID" or "BOT" or "SUPPORT" ? value : null;
    }
}
