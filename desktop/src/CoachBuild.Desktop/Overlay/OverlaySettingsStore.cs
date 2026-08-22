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
    /// The shared account secret the ranked-LP capture posts with
    /// (<c>MYSTATS_ACCOUNT_SECRET</c> / <c>x-coachbuild-account-secret</c>).
    /// Empty or absent means capture is INERT — nothing is posted and one line
    /// says so in the log.
    ///
    /// <para>The tray's “Pair desktop with My Stats” dialog writes this field
    /// through <see cref="OverlaySettingsStore.SetRankSampleSecret"/>. The
    /// dialog is a masked, paste-only handoff and is never given the existing
    /// value to echo back. PowerShell reads this same settings key, so either
    /// companion uses the one persisted credential.</para>
    ///
    /// <para>It must be a real property rather than an unmodelled JSON key:
    /// <c>Save()</c> serialises this exact type, so a key this class does not
    /// know about is DELETED the next time the user toggles the overlay.</para>
    /// </summary>
    [JsonPropertyName("rankSampleSecret")]
    public string? RankSampleSecret { get; set; }

    public Dictionary<string, PersistedCalibration> Calibrations { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// The item row the WPA numbers used to be drawn on. NOTHING READS THIS.
    ///
    /// <para><b>It is kept solely so the player's saved geometry survives.</b>
    /// 1.0.23 removed the item-number overlay; this property is the only reason
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

    /// <summary>
    /// Persists the shared account credential in the app's existing settings
    /// file. Blank input removes it; every capture caller treats that as INERT.
    /// </summary>
    public void SetRankSampleSecret(string? secret)
    {
        lock (_gate)
        {
            var settings = ReadCore();
            settings.RankSampleSecret = NormalizeSecret(secret);
            WriteCore(settings);
        }
    }

    public void SaveCalibration(DisplayResolution display, CalibrationGeometry geometry)
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
    }

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
            // the next write of ANY other setting. That is also why
            // ItemRowCalibrations is cloned below despite nothing reading it.
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
        settings.RankSampleSecret = NormalizeSecret(settings.RankSampleSecret);
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

    private static string? NormalizeSecret(string? secret)
    {
        var value = secret?.Trim();
        return string.IsNullOrEmpty(value) ? null : value;
    }
}
