using CoachBuild.Desktop.Updates;

namespace CoachBuild.Desktop.Tray;

/// <summary>
/// The phase values emitted by the LCU gameflow endpoint. Unknown values are
/// deliberately retained as <see cref="Unknown"/> so a future League phase
/// cannot accidentally make Reopen perform a write or open the wrong page.
/// </summary>
public enum CompanionPhase
{
    Unknown,
    None,
    Lobby,
    Matchmaking,
    ReadyCheck,
    Reconnect,
    ChampSelect,
    InProgress,
    WaitingForStats,
    EndOfGame,
    PreEndOfGame,
}

public enum ReopenDestination
{
    Home,
    Draft,
    Builds,
}

public enum WebView2Availability
{
    Unknown,
    Available,
    Missing,
}

public sealed record ReopenTarget(
    ReopenDestination Destination,
    int? ChampionId = null,
    int? RoleId = null);

public sealed record LastOpenPage(
    int ChampionId,
    int? RoleId,
    DateTimeOffset OpenedAt,
    ReopenDestination Destination = ReopenDestination.Builds);

/// <summary>
/// Immutable input for the tray projection. Keeping this separate from
/// NotifyIcon makes the phase/reopen rules deterministic and unit-testable.
/// </summary>
public sealed record TrayMenuState(
    CompanionPhase Phase,
    bool OverlayVisible,
    bool Interactive,
    string? LaneOverride,
    bool IsCompanionBusy,
    string? Error,
    UpdateTrayModel Update,
    LastOpenPage? LastOpen,
    WebView2Availability WebView2Available = WebView2Availability.Unknown,
    bool IsAdjusting = false,
    string? AdjustAccelerator = null,
    string? AdjustHotkeyAdvice = null)
{
    /// <summary>
    /// The tray wording for adjust mode, in one place. <see
    /// cref="Overlay.GlobalHotkeyService.FallbackAdviceOrNull"/> quotes this
    /// item by name when no accelerator could be bound, so the advice and the
    /// menu cannot come to disagree about what the user is being told to click.
    /// </summary>
    public const string AdjustMenuVerb = "Adjust overlay position";

    public const string CancelAdjustMenuVerb = "Cancel adjust";

    public const string OpenLogFolderVerb = "Open log folder";

    /// <summary>
    /// Names the accelerator in a menu label — and, when <paramref
    /// name="accelerator"/> is null, deliberately does not.
    ///
    /// <para><b>The null branch is the point.</b> <c>RegisterHotKey</c> is
    /// exclusive system-wide, so on a machine where another app already owns
    /// Ctrl+Shift+A this app has no shortcut at all. A label that named one
    /// anyway would be the menu promising a key that does nothing, which is
    /// worse than the unlabelled item it replaced. The caller passes
    /// <see cref="Overlay.GlobalHotkeyService.RegisteredAdjustAccelerator"/>,
    /// which is null in exactly that case; the tooltip then carries
    /// <see cref="AdjustHotkeyAdvice"/> so the failure is still visible.</para>
    /// </summary>
    public static string WithAccelerator(string verb, string? accelerator) =>
        string.IsNullOrWhiteSpace(accelerator) ? verb : $"{verb} ({accelerator})";

    public static TrayMenuState Default { get; } = new(
        CompanionPhase.None,
        OverlayVisible: true,
        Interactive: false,
        LaneOverride: null,
        IsCompanionBusy: false,
        Error: null,
        UpdateTrayModel.None,
        LastOpen: null,
        WebView2Available: WebView2Availability.Unknown,
        IsAdjusting: false);

    public bool IsInGame => Phase is CompanionPhase.InProgress or CompanionPhase.WaitingForStats;

    public bool IsChampSelect => Phase == CompanionPhase.ChampSelect;

    /// <summary>
    /// Reopen is a view action only. During champ select it keeps the draft
    /// page in front; during a live game it keeps Builds in front. Outside a
    /// tracked phase, the last native page is reused when it is still known.
    /// </summary>
    public ReopenTarget GetReopenTarget()
    {
        return Phase switch
        {
            CompanionPhase.ChampSelect => new(ReopenDestination.Draft, LastOpen?.ChampionId, LastOpen?.RoleId),
            CompanionPhase.InProgress or CompanionPhase.WaitingForStats => new(ReopenDestination.Builds, LastOpen?.ChampionId, LastOpen?.RoleId),
            _ when LastOpen is not null => new(LastOpen.Destination, LastOpen.ChampionId, LastOpen.RoleId),
            _ => new(ReopenDestination.Home),
        };
    }

    public TrayMenuState WithPhase(
        string? phase,
        LastOpenPage? lastOpen = null,
        bool? isBusy = null,
        string? error = null)
    {
        return this with
        {
            Phase = ParsePhase(phase),
            LastOpen = lastOpen ?? LastOpen,
            IsCompanionBusy = isBusy ?? IsCompanionBusy,
            Error = error,
        };
    }

    public static CompanionPhase ParsePhase(string? phase)
    {
        if (string.IsNullOrWhiteSpace(phase)) return CompanionPhase.Unknown;

        return Enum.TryParse<CompanionPhase>(phase.Trim(), true, out var parsed)
            ? parsed
            : CompanionPhase.Unknown;
    }

    public static string? NormalizeLane(string? lane)
    {
        if (string.IsNullOrWhiteSpace(lane)) return null;
        var normalized = lane.Trim().ToUpperInvariant();
        return normalized is "TOP" or "JUNGLE" or "MID" or "BOT" or "SUPPORT"
            ? normalized
            : null;
    }

    public static string FormatWorkingSet(long bytes)
    {
        var megabytes = Math.Max(0, bytes) / (1024d * 1024d);
        return $"Working set: {megabytes:0} MB";
    }
}
