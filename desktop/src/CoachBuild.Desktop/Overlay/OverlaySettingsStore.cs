using System.Text.Json;
using System.Text.Json.Serialization;

namespace CoachBuild.Desktop.Overlay;

public sealed class OverlaySettings
{
    public string? LaneOverride { get; set; }

    public bool ShowSkillTable { get; set; }

    public bool OverlayVisible { get; set; } = true;

    public Dictionary<string, PersistedCalibration> Calibrations { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed class PersistedCalibration
{
    public DisplayResolution Resolution { get; set; }

    public CalibrationGeometry Geometry { get; set; } = CalibrationGeometry.Reference;
}

/// <summary>
/// Merge-safe settings persistence for lane, table visibility, and
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

    public OverlaySettingsStore(string path)
    {
        _path = path ?? throw new ArgumentNullException(nameof(path));
    }

    public string Path => _path;

    public OverlaySettings Read()
    {
        lock (_gate)
        {
            return ReadCore();
        }
    }

    public void Save(OverlaySettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        lock (_gate)
        {
            WriteCore(Normalize(settings));
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

    public void SetShowSkillTable(bool visible)
    {
        lock (_gate)
        {
            var settings = ReadCore();
            settings.ShowSkillTable = visible;
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

        return new OverlaySettings();
    }

    private void WriteCore(OverlaySettings settings)
    {
        var directory = System.IO.Path.GetDirectoryName(_path);
        if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);

        var temporary = _path + ".tmp-" + Guid.NewGuid().ToString("N");
        File.WriteAllText(temporary, JsonSerializer.Serialize(settings, JsonOptions));
        File.Move(temporary, _path, overwrite: true);
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
                ShowSkillTable = root.TryGetProperty("showSkillTable", out var table) && table.ValueKind == JsonValueKind.True,
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
        settings.Calibrations ??= new Dictionary<string, PersistedCalibration>(StringComparer.OrdinalIgnoreCase);
        settings.Calibrations = settings.Calibrations
            .Where(pair => pair.Value is not null)
            .ToDictionary(
                pair => pair.Key,
                pair => new PersistedCalibration
                {
                    Resolution = pair.Value.Resolution,
                    Geometry = pair.Value.Geometry.Normalize(),
                },
                StringComparer.OrdinalIgnoreCase);
        return settings;
    }

    private static string? NormalizeLane(string? lane)
    {
        if (string.IsNullOrWhiteSpace(lane)) return null;
        var value = lane.Trim().ToUpperInvariant();
        return value is "TOP" or "JUNGLE" or "MID" or "BOT" or "SUPPORT" ? value : null;
    }
}
