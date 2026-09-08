using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using CoachBuild.Desktop.Web;

namespace CoachBuild.Desktop.Overlay;

public sealed class OverlaySettings
{
    public string? LaneOverride { get; set; }

    public bool OverlayVisible { get; set; } = true;

    /// <summary>
    /// The last companion-window tab selected by the user. This is a stable
    /// key (for example <c>companion</c>, <c>ugg</c>, <c>coachless</c>, or
    /// <c>opgg</c>),
    /// rather than the enum name, so changing the native UI's type names does
    /// not strand an existing profile. Unknown keys are normalised to
    /// <c>companion</c> when the settings are read.
    /// </summary>
    [JsonPropertyName("lastCompanionTab")]
    public string LastCompanionTab { get; set; } = OverlaySettingsStore.CompanionTabKey;

    /// <summary>
    /// WebView zoom factors keyed by the same stable site keys used by the
    /// companion tab model. The map intentionally includes the hosted
    /// Companion tab as well as third-party sites; the UI can use one helper
    /// for every destination.
    /// </summary>
    [JsonPropertyName("zoomFactors")]
    public Dictionary<string, double> ZoomFactors { get; set; } = new(StringComparer.OrdinalIgnoreCase);

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
/// Merge-safe settings persistence for lane, overlay visibility, companion tab
/// preferences, and resolution/DPI-tagged calibration. It also reads the
/// Electron settings shape once, so an upgrade does not silently discard a
/// user's alignment.
/// </summary>
public sealed class OverlaySettingsStore : ICompanionTabsPreferencesStore
{
    public const string CompanionTabKey = "companion";
    public const string UggTabKey = "ugg";
    public const string CoachlessTabKey = "coachless";
    public const string OpGgTabKey = "opgg";

    // Keep the persistence boundary in lockstep with the typed tab model. A
    // corrupt profile can therefore never make a WebView zoom operation leave
    // the range the tab UI promises to its callers.
    public const double DefaultZoomFactor = CompanionTabsPreferences.DefaultZoomFactor;
    public const double MinZoomFactor = CompanionTabsPreferences.MinZoomFactor;
    public const double MaxZoomFactor = CompanionTabsPreferences.MaxZoomFactor;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.General)
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter() },
    };

    // Each store instance has its own cache and lock, so two callers in this
    // process can otherwise perform stale read/modify/write cycles. This gate
    // closes that window. The desktop app is single-instance, so no separate
    // lock-file protocol is needed for the production process boundary.
    private static readonly ConcurrentDictionary<string, object> ProcessGates = new(StringComparer.OrdinalIgnoreCase);

    private readonly object _gate = new();
    private readonly string _path;
    private readonly string _canonicalPath;
    private OverlaySettings? _cachedSettings;
    private CompanionTabsPreferences? _cachedCompanionPreferences;

    public OverlaySettingsStore(string path)
    {
        _path = path ?? throw new ArgumentNullException(nameof(path));
        _canonicalPath = System.IO.Path.GetFullPath(_path);
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
            lock (GetProcessGate())
            {
                WriteCore(Normalize(CloneSettings(settings)));
            }
        }
    }

    public void SetLaneOverride(string? lane)
    {
        lock (_gate)
        {
            lock (GetProcessGate())
            {
                var settings = ReadLatestCore();
                settings.LaneOverride = NormalizeLane(lane);
                WriteCore(settings);
            }
        }
    }

    public void SetOverlayVisible(bool visible)
    {
        lock (_gate)
        {
            lock (GetProcessGate())
            {
                var settings = ReadLatestCore();
                settings.OverlayVisible = visible;
                WriteCore(settings);
            }
        }
    }

    public void SetAutostartConfigured(bool configured)
    {
        lock (_gate)
        {
            lock (GetProcessGate())
            {
                var settings = ReadLatestCore();
                settings.AutostartConfigured = configured;
                WriteCore(settings);
            }
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
            lock (GetProcessGate())
            {
                var settings = ReadLatestCore();
                settings.RankSampleSecret = NormalizeSecret(secret);
                WriteCore(settings);
            }
        }
    }

    /// <summary>
    /// Stores the user's last selected companion tab. The key is deliberately
    /// string-based so this settings layer does not depend on the WebView tab
    /// model; <c>CompanionTabs.KeyFor</c> is the producer of the keys in the UI.
    /// Invalid or missing values fail closed to the hosted Companion tab.
    /// </summary>
    public void SetLastCompanionTab(string? tabKey)
    {
        lock (_gate)
        {
            lock (GetProcessGate())
            {
                var settings = ReadLatestCore();
                settings.LastCompanionTab = NormalizeCompanionTabKey(tabKey);
                WriteCore(settings);
            }
        }
    }

    /// <summary>Returns the persisted zoom for a tab/site, or 1.0 by default.</summary>
    public double GetZoomFactor(string? siteKey)
    {
        var key = NormalizeSiteKey(siteKey);
        if (key is null) return DefaultZoomFactor;

        lock (_gate)
        {
            var settings = ReadCore();
            return settings.ZoomFactors.TryGetValue(key, out var factor)
                ? NormalizeZoomFactor(factor)
                : DefaultZoomFactor;
        }
    }

    /// <summary>
    /// Persists a tab/site zoom factor after clamping it to WebView2's safe
    /// range. Non-finite values fall back to the default factor.
    /// </summary>
    public void SetZoomFactor(string? siteKey, double factor)
    {
        var key = NormalizeSiteKey(siteKey);
        if (key is null) return;

        lock (_gate)
        {
            lock (GetProcessGate())
            {
                var settings = ReadLatestCore();
                settings.ZoomFactors[key] = NormalizeZoomFactor(factor);
                WriteCore(settings);
            }
        }
    }

    /// <summary>
    /// Adapts the existing native settings store to the typed seam consumed by
    /// the companion WebView. The persisted document remains flat and keyed by
    /// stable strings; the Web layer can therefore use its enum without
    /// changing the long-lived desktop settings shape.
    /// </summary>
    CompanionTabsPreferences ICompanionTabsPreferencesStore.Read()
    {
        lock (_gate)
        {
            var preferences = ToCompanionTabsPreferences(ReadCore());
            _cachedCompanionPreferences = preferences;
            return preferences;
        }
    }

    void ICompanionTabsPreferencesStore.Save(CompanionTabsPreferences preferences) =>
        SaveCompanionTabsPreferences(preferences);

    private void SaveCompanionTabsPreferences(CompanionTabsPreferences preferences)
    {
        ArgumentNullException.ThrowIfNull(preferences);
        lock (_gate)
        {
            lock (GetProcessGate())
            {
                var settings = ReadLatestCore();
                MergeCompanionPreferences(settings, preferences, _cachedCompanionPreferences);

                WriteCore(settings);
                _cachedCompanionPreferences = ToCompanionTabsPreferences(settings);
            }
        }
    }

    public void SaveCalibration(DisplayResolution display, CalibrationGeometry geometry)
    {
        lock (_gate)
        {
            lock (GetProcessGate())
            {
                var settings = ReadLatestCore();
                settings.Calibrations[display.Key] = new PersistedCalibration
                {
                    Resolution = display,
                    Geometry = geometry.Normalize(),
                };
                WriteCore(settings);
            }
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

        return _cachedSettings = ReadLatestCore();
    }

    /// <summary>
    /// Reads the current on-disk snapshot, bypassing this instance's cache.
    /// Every mutation uses this path so a store created before another store's
    /// write still merges the latest settings instead of restoring its stale
    /// snapshot.
    /// </summary>
    private OverlaySettings ReadLatestCore()
    {
        var settings = TryRead(_path);
        if (settings is not null) return Normalize(settings);

        // Electron's old path/shape. This is read-only migration input; the
        // first native write moves it into the new file.
        var legacyPath = System.IO.Path.Combine(
            System.IO.Path.GetDirectoryName(_path) ?? string.Empty,
            "coachbuild-overlay-settings.json");
        if (!string.Equals(legacyPath, _path, StringComparison.OrdinalIgnoreCase))
        {
            var legacy = TryReadLegacy(legacyPath);
            if (legacy is not null) return Normalize(legacy);
        }

        return Normalize(new OverlaySettings());
    }

    private object GetProcessGate() =>
        ProcessGates.GetOrAdd(_canonicalPath, static _ => new object());

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
            LastCompanionTab = settings.LastCompanionTab,
            ZoomFactors = CloneZoomFactors(settings.ZoomFactors),
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

    private static Dictionary<string, double> CloneZoomFactors(
        Dictionary<string, double>? factors)
    {
        var result = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        if (factors is null) return result;

        foreach (var pair in factors)
        {
            if (NormalizeSiteKey(pair.Key) is { } key)
                result[key] = NormalizeZoomFactor(pair.Value);
        }

        return result;
    }

    private static CompanionTabsPreferences ToCompanionTabsPreferences(OverlaySettings settings)
    {
        var zooms = new Dictionary<CompanionTab, double>();
        foreach (var tab in CompanionTabs.Order)
        {
            var key = CompanionTabs.KeyFor(tab);
            if (settings.ZoomFactors.TryGetValue(key, out var factor))
                zooms[tab] = NormalizeZoomFactor(factor);
        }

        return new(CompanionTabs.ParseKey(settings.LastCompanionTab), zooms);
    }

    private static void MergeCompanionPreferences(
        OverlaySettings latest,
        CompanionTabsPreferences incoming,
        CompanionTabsPreferences? baseline)
    {
        // A preference object is a snapshot. If it came from this store, only
        // write fields the caller changed from that snapshot; this keeps a
        // second store's newer tab/zoom choice intact. A caller with no read
        // baseline is treated as a complete initial preference snapshot.
        if (baseline is null || incoming.LastTab != baseline.LastTab)
            latest.LastCompanionTab = CompanionTabs.KeyFor(incoming.LastTab);

        foreach (var tab in CompanionTabs.Order)
        {
            var incomingHas = incoming.ZoomFactors.TryGetValue(tab, out var incomingZoom);
            // Not `baseline?.ZoomFactors.TryGetValue(...)`: a conditional access
            // may skip the call, so the compiler cannot prove the out variable
            // was assigned.
            var baselineZoom = CompanionTabsPreferences.DefaultZoomFactor;
            var baselineHas = baseline is not null
                && baseline.ZoomFactors.TryGetValue(tab, out baselineZoom);
            var changed = baseline is null
                ? incomingHas
                : incomingHas != baselineHas
                    || incomingHas && !AreEqualZooms(incomingZoom, baselineZoom);
            if (!changed) continue;

            var key = CompanionTabs.KeyFor(tab);
            if (incomingHas)
                latest.ZoomFactors[key] = NormalizeZoomFactor(incomingZoom);
            else
                latest.ZoomFactors.Remove(key);
        }
    }

    private static bool AreEqualZooms(double left, double right) =>
        NormalizeZoomFactor(left) == NormalizeZoomFactor(right);

    private static OverlaySettings? TryRead(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            return JsonSerializer.Deserialize<OverlaySettings>(File.ReadAllText(path), JsonOptions);
        }
        catch
        {
            // A malformed preference value should not hide otherwise valid
            // overlay settings. Recover the two newer preference properties
            // independently, then let the normal serializer validate the
            // established settings shape.
            try
            {
                if (!File.Exists(path)) return null;
                using var document = JsonDocument.Parse(File.ReadAllText(path));
                if (document.RootElement.ValueKind != JsonValueKind.Object) return null;

                var values = new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
                foreach (var property in document.RootElement.EnumerateObject())
                    values[property.Name] = property.Value.Clone();

                foreach (var property in document.RootElement.EnumerateObject())
                {
                    if (string.Equals(property.Name, "lastCompanionTab", StringComparison.OrdinalIgnoreCase)
                        && property.Value.ValueKind is not (JsonValueKind.String or JsonValueKind.Null))
                    {
                        values[property.Name] = JsonSerializer.SerializeToElement(CompanionTabKey, JsonOptions);
                    }

                    if (!string.Equals(property.Name, "zoomFactors", StringComparison.OrdinalIgnoreCase)) continue;

                    var factors = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
                    if (property.Value.ValueKind == JsonValueKind.Object)
                    {
                        foreach (var factor in property.Value.EnumerateObject())
                        {
                            if (factor.Value.ValueKind == JsonValueKind.Number
                                && factor.Value.TryGetDouble(out var number)
                                && double.IsFinite(number))
                                factors[factor.Name] = number;
                        }
                    }

                    values[property.Name] = JsonSerializer.SerializeToElement(factors, JsonOptions);
                }

                return JsonSerializer.Deserialize<OverlaySettings>(
                    JsonSerializer.Serialize(values, JsonOptions),
                    JsonOptions);
            }
            catch
            {
                return null;
            }
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
        settings.LastCompanionTab = NormalizeCompanionTabKey(settings.LastCompanionTab);
        settings.ZoomFactors = CloneZoomFactors(settings.ZoomFactors);
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

    private static string NormalizeCompanionTabKey(string? tabKey) =>
        tabKey?.Trim().ToLowerInvariant() switch
        {
            UggTabKey => UggTabKey,
            CoachlessTabKey => CoachlessTabKey,
            OpGgTabKey => OpGgTabKey,
            _ => CompanionTabKey,
        };

    private static string? NormalizeSiteKey(string? siteKey)
    {
        if (string.IsNullOrWhiteSpace(siteKey)) return null;

        var value = siteKey.Trim().ToLowerInvariant();
        return value is CompanionTabKey or UggTabKey or CoachlessTabKey or OpGgTabKey
            ? value
            : null;
    }

    private static double NormalizeZoomFactor(double factor)
    {
        if (double.IsNaN(factor) || double.IsInfinity(factor)) return DefaultZoomFactor;
        return Math.Clamp(factor, MinZoomFactor, MaxZoomFactor);
    }
}
