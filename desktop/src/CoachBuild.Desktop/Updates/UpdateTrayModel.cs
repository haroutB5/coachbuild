namespace CoachBuild.Desktop.Updates;

public enum UpdateStatus
{
    None,
    Checking,
    Downloading,
    Ready,

    /// <summary>
    /// Downloaded and waiting for a restart the user has to consent to,
    /// because the CoachBuild window is on screen. Distinct from
    /// <see cref="DeferredBusy"/>, which resolves on its own.
    /// </summary>
    Staged,
    DeferredBusy,
    Applying,
    Error,
}

public sealed class UpdateTrayModel : EventArgs
{
    public UpdateTrayModel(
        UpdateStatus status,
        string? version,
        string? detail,
        DateTimeOffset? changedAt = null)
    {
        Status = status;
        Version = version;
        Detail = detail;
        ChangedAt = changedAt;
    }

    public UpdateStatus Status { get; }

    public string? Version { get; }

    public string? Detail { get; }

    public DateTimeOffset? ChangedAt { get; }

    public static UpdateTrayModel None { get; } = new(UpdateStatus.None, null, null);

    public bool IsReady => Status is UpdateStatus.Ready or UpdateStatus.Staged or UpdateStatus.DeferredBusy;

    /// <summary>
    /// True when a downloaded release is sitting there and only a restart is
    /// missing, so the tray can offer the restart as an action rather than as
    /// a disabled status line.
    /// </summary>
    public bool CanRestartToUpdate => IsReady && !string.IsNullOrWhiteSpace(Version);

    public bool IsError => Status == UpdateStatus.Error;

    public string ToDisplayString()
    {
        return Status switch
        {
            UpdateStatus.None => "up to date",
            UpdateStatus.Checking => "checking…",
            UpdateStatus.Downloading => Version is null ? "downloading…" : $"downloading {Version}…",
            UpdateStatus.Ready => Version is null ? "ready" : $"{Version} ready",
            UpdateStatus.Staged => Version is null ? "ready · restart to update" : $"{Version} ready · restart to update",
            UpdateStatus.DeferredBusy => Version is null ? "ready · waiting for game" : $"{Version} ready · waiting for game",
            UpdateStatus.Applying => "applying…",
            UpdateStatus.Error => Detail is null ? "error" : $"error · {Detail}",
            _ => "unknown",
        };
    }

    public static UpdateTrayModel For(UpdateStatus status, string? version = null, string? detail = null)
    {
        return new UpdateTrayModel(status, version, detail, DateTimeOffset.UtcNow);
    }
}
