namespace CoachBuild.Core;

public enum WindowDecisionKind
{
    None,
    OpenDraft,
    ReopenDraft,
    ReopenBuilds,
    PairingPage
}

public sealed record WindowDecision(WindowDecisionKind Kind, string? Url = null, int? ChampionId = null, int? RoleId = null);

public sealed class WindowDecisionService
{
    private readonly FollowAttachmentTracker _attachments;
    private readonly DeepLinkService _links;
    private readonly string _sessionToken;
    private readonly object _gate = new();
    private int? _lastOpenedChampionId;
    private int? _lastOpenedRoleId;
    private bool _wasChampSelect;

    public WindowDecisionService(
        string sessionToken,
        DeepLinkService? links = null,
        FollowAttachmentTracker? attachments = null)
    {
        _sessionToken = sessionToken;
        _links = links ?? new DeepLinkService();
        _attachments = attachments ?? new FollowAttachmentTracker();
    }

    public int? LastOpenedChampionId { get { lock (_gate) return _lastOpenedChampionId; } }
    public int? LastOpenedRoleId { get { lock (_gate) return _lastOpenedRoleId; } }
    public FollowAttachmentTracker Attachments => _attachments;

    public WindowDecision OnChampSelectEntry(
        DateTimeOffset? now = null,
        bool browserAlive = true)
        => OnChampSelectEntry(null, now, browserAlive);

    public WindowDecision OnChampSelectEntry(
        ChampSelectResolution? resolution,
        DateTimeOffset? now = null,
        bool browserAlive = true)
    {
        lock (_gate)
        {
            _wasChampSelect = true;
            _lastOpenedChampionId = resolution?.ChampionId is > 0 ? resolution.ChampionId : null;
            _lastOpenedRoleId = resolution?.ChampionId is > 0 ? resolution.RoleId : null;
        }
        var at = now ?? DateTimeOffset.UtcNow;
        if (_attachments.IsAnyAttached(at, browserAlive))
            return new WindowDecision(
                WindowDecisionKind.None,
                ChampionId: resolution?.ChampionId,
                RoleId: resolution?.RoleId);
        var url = _links.GetDraftDeepLinkUrl(_sessionToken);
        _attachments.RecordOpened(FollowKind.Draft, at);
        return new WindowDecision(
            WindowDecisionKind.OpenDraft,
            url,
            resolution?.ChampionId,
            resolution?.RoleId);
    }

    public WindowDecision OnChampSelectPoll(
        ChampSelectResolution resolution,
        DateTimeOffset? now = null,
        bool browserAlive = true)
    {
        var at = now ?? DateTimeOffset.UtcNow;
        lock (_gate)
        {
            if (!_wasChampSelect)
            {
                _wasChampSelect = true;
                _lastOpenedChampionId = null;
                _lastOpenedRoleId = null;
            }
            if (resolution.ChampionId is not > 0)
                return new WindowDecision(WindowDecisionKind.None);
            if (_lastOpenedChampionId == resolution.ChampionId)
                return new WindowDecision(WindowDecisionKind.None, ChampionId: resolution.ChampionId, RoleId: resolution.RoleId);
            _lastOpenedChampionId = resolution.ChampionId;
            _lastOpenedRoleId = resolution.RoleId;
        }

        // The one-window rule is combined across Builds and Draft. A live
        // follow from either surface is sufficient to avoid a new window.
        if (_attachments.IsAnyAttached(at, browserAlive))
            return new WindowDecision(WindowDecisionKind.None, ChampionId: resolution.ChampionId, RoleId: resolution.RoleId);

        var url = _links.GetDraftDeepLinkUrl(_sessionToken);
        _attachments.RecordOpened(FollowKind.Draft, at);
        return new WindowDecision(WindowDecisionKind.OpenDraft, url, resolution.ChampionId, resolution.RoleId);
    }

    public void OnPhaseChanged(string phase)
    {
        lock (_gate)
        {
            if (!string.Equals(phase, "ChampSelect", StringComparison.Ordinal))
            {
                _wasChampSelect = false;
            }
        }
    }

    public WindowDecision Reopen(string phase)
    {
        int? champion;
        int? role;
        lock (_gate)
        {
            champion = _lastOpenedChampionId;
            role = _lastOpenedRoleId;
        }
        var isChampSelect = string.Equals(phase, "ChampSelect", StringComparison.Ordinal);
        var url = _links.GetReopenUrl(phase, champion, role, _sessionToken);
        var kind = isChampSelect
            ? WindowDecisionKind.ReopenDraft
            : champion is > 0 ? WindowDecisionKind.ReopenBuilds : WindowDecisionKind.PairingPage;
        return new WindowDecision(kind, url, champion, role);
    }
}
